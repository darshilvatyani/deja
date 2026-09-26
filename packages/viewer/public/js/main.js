import { buildModel, CHANNELS } from './model.js';
import { StripChart } from './chart.js';
import { Tape } from './tape.js';
import { Inspector } from './inspector.js';
import { esc, describe, fmtMs, fmtBytes, num } from './format.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- theme

const media = window.matchMedia('(prefers-color-scheme: dark)');
let chart = null;

function resolvedTheme() {
  const set = document.documentElement.dataset.theme;
  return set === 'light' || set === 'dark' ? set : media.matches ? 'dark' : 'light';
}

function syncTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.resolvedTheme = t;
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.dataset.themeSet === t));
  if (chart) chart.refreshTheme();
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('deja-theme', t); } catch {}
  syncTheme();
}

document.querySelector('.switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (b) setTheme(b.dataset.themeSet);
});
media.addEventListener('change', syncTheme);
syncTheme();

// ---------------------------------------------------------------- app

const state = {
  model: null,
  selected: null,
  channels: new Set(['in', 'out', 'time', 'rand', 'ops', 'fault']),
  rid: 0,
  q: '',
  rows: [],
};
let tape = null;
let inspector = null;
const haystacks = new Map();

function haystack(ev) {
  let h = haystacks.get(ev.i);
  if (h === undefined) {
    h = `#${ev.i} ${ev.k} ${describe(ev)} ${ev.s || ''} ${ev.a || ''} ${ev.h !== undefined ? `h${ev.h}` : ''} ${ev.rid ? `r${ev.rid}` : ''}`.toLowerCase();
    haystacks.set(ev.i, h);
  }
  return h;
}

function matches(ev) {
  if (!state.channels.has(ev.ch)) return false;
  if (state.rid && ev.rid !== state.rid) return false;
  if (state.q && !haystack(ev).includes(state.q)) return false;
  return true;
}

function applyFilter() {
  const rows = [];
  for (const ev of state.model.events) if (matches(ev)) rows.push(ev.i);
  state.rows = rows;
  tape.setRows(rows);
  chart.match = matches;
  chart.focusRid = state.rid;
  chart.draw();
  $('count').textContent = rows.length === state.model.events.length
    ? `${num(rows.length)} events`
    : `${num(rows.length)} of ${num(state.model.events.length)} events`;
}

function select(i, { scroll = true } = {}) {
  const ev = state.model.events[i];
  if (!ev) return;
  state.selected = i;
  chart.selected = i;
  chart.reveal(i);
  chart.draw();
  tape.select(i, { scroll });
  inspector.show(i);
  $('stateN').textContent = `#${i}`;
}

function step(kind) {
  const { rows, model } = state;
  if (!rows.length) return;
  const cur = state.selected ?? -1;
  const pos = rows.findIndex((i) => i >= cur);
  const at = pos < 0 ? rows.length : pos;
  const exact = rows[at] === cur;
  let target = null;
  if (kind === 'first') target = rows[0];
  else if (kind === 'last') target = rows[rows.length - 1];
  else if (kind === 'next') target = rows[exact ? at + 1 : at];
  else if (kind === 'prev') target = rows[at - 1];
  else if (kind === 'next-delivery') target = rows.slice(exact ? at + 1 : at).find((i) => model.events[i].delivery);
  else if (kind === 'prev-delivery') target = rows.slice(0, at).reverse().find((i) => model.events[i].delivery);
  else if (kind === 'crash' && model.crash) target = model.crash.i;
  if (target !== undefined && target !== null) select(target);
}

// ---------------------------------------------------------------- static parts

function renderLabel(m) {
  const h = m.header;
  const rel = (p) => (p && h.cwd && p.startsWith(h.cwd) ? p.slice(h.cwd.length + 1) : p);
  const file = m.file.split('/').pop();
  const created = new Date(h.createdAt);
  const when = Number.isNaN(created.getTime()) ? h.createdAt : `${created.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${created.toLocaleTimeString()}`;
  const ended = m.trailer ? (m.trailer.exit && m.trailer.exit.signal ? `signal ${m.trailer.exit.signal}` : `exit ${m.trailer.exit ? m.trailer.exit.code : '?'}`) : 'cut short';
  const rows = [
    ['Recording', `${esc(file)}${h.label ? ` · ${esc(h.label)}` : ''}`],
    ['Program', `node ${esc(rel(h.entry) || '?')} ${esc((h.argv || []).join(' '))}`],
    ['Captured', `${esc(when)} · ${esc(h.hostname)}`],
    ['Runtime', `node ${esc(h.node)} · ${esc(h.platform)}/${esc(h.arch)}${h.git ? ` · git ${esc(h.git.slice(0, 8))}` : ''}`],
    ['Contents', `${num(m.events.length)} events · ${num(m.requests.size)} requests · ${fmtMs(m.span)}`],
    ['On disk', `${fmtBytes(m.size)} ${esc(h.codec)} · ended by ${esc(ended)}`],
  ];
  $('label').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd title="${v.replace(/<[^>]+>/g, '')}">${v}</dd></div>`).join('');
  document.title = `déjà · ${file}`;
}

function renderIncident(m) {
  const el = $('incident');
  const c = m.crash;
  if (c) {
    const req = c.rid && m.requests.get(c.rid);
    el.className = 'incident crashed';
    el.innerHTML =
      '<span class="tag">incident</span>' +
      `<div><p class="what">${esc(c.v.message)}</p>` +
      `<p class="meta">${esc(c.v.name)} · thrown at <button class="linkish" data-jump="${c.i}">event #${c.i}</button> · ${fmtMs(c.t)} into the recording` +
      `${req ? ` · while serving <button class="linkish" data-rid="${req.rid}">request #${req.rid} ${esc(req.method)} ${esc(req.url)}</button>` : ''}</p></div>` +
      '<div class="actions"><div class="verdict" id="verdict"></div><button type="button" class="btn primary" id="replayBtn">Replay this crash</button></div>';
  } else {
    el.className = 'incident';
    const ended = m.trailer && m.trailer.exit && m.trailer.exit.signal ? `stopped with ${m.trailer.exit.signal}` : 'exited';
    el.innerHTML =
      '<span class="tag">recording</span>' +
      `<div><p class="what">A clean run — nothing crashed.</p><p class="meta">${num(m.requests.size)} requests over ${fmtMs(m.span)}, then the process ${ended}. Replay it to prove every byte comes back the same.</p></div>` +
      '<div class="actions"><div class="verdict" id="verdict"></div><button type="button" class="btn primary" id="replayBtn">Replay &amp; verify</button></div>';
  }
  el.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) select(Number(jump.dataset.jump));
    const r = e.target.closest('[data-rid]');
    if (r) {
      const req = m.requests.get(Number(r.dataset.rid));
      if (req) { select(req.startI); inspector.setTab('request'); }
    }
  });
  $('replayBtn').addEventListener('click', runReplay);
}

async function runReplay() {
  const btn = $('replayBtn');
  const out = $('verdict');
  btn.disabled = true;
  document.body.classList.add('busy');
  out.innerHTML = `<small><span class="meter" style="display:inline-block;vertical-align:middle"></span> replaying ${num(state.model.events.length)} events offline…</small>`;
  try {
    const res = await fetch('/api/replay', { method: 'POST' }).then((r) => r.json());
    const r = res.report;
    if (!r) throw new Error(res.error || 'replay produced no report');
    const good = r.status === 'reproduced' || r.status === 'faithful';
    const lines = [`${num(r.replayed)}/${num(r.totalEvents)} events · ${fmtMs(r.wallMs)} (recorded ${fmtMs(r.recordedSpanMs)})`,
      `${num(r.outputs.compared)} socket writes verified${r.outputs.mismatched ? `, ${r.outputs.mismatched} differ` : ''}`];
    if (r.crash && r.crash.match) lines.push(`same crash at #${r.crash.at}`);
    if (r.divergence) lines.push(`diverged at <button class="linkish" data-jump="${Math.min(r.divergence.at, state.model.events.length - 1)}">#${r.divergence.at}</button>: ${esc(r.divergence.message)}`);
    if (r.warnings.count) lines.push(`${r.warnings.count} warning${r.warnings.count > 1 ? 's' : ''} (${esc(r.warnings.items[0].type)} at #${r.warnings.items[0].at})`);
    out.innerHTML = `<span class="stamp ${good ? 'ok' : 'bad'}">${esc(r.status)}</span><small>${lines.join('<br>')}</small>`;
  } catch (err) {
    out.innerHTML = `<span class="stamp bad">error</span><small>${esc(err.message)}</small>`;
  } finally {
    btn.disabled = false;
    document.body.classList.remove('busy');
  }
}

function renderLegend() {
  $('legend').innerHTML =
    '<span><em class="glyph">▼</em>world → app</span>' +
    '<span><em class="glyph">│</em>app → world</span>' +
    '<span><em class="glyph" style="color:var(--ch-rand)">∿</em>Math.random</span>' +
    '<span><em class="glyph" style="color:var(--ch-time)">—</em>timer wait</span>' +
    '<span><i style="background:var(--ch-req)"></i>request</span>';
}

function renderChips(m) {
  const counts = {};
  for (const ev of m.events) counts[ev.ch] = (counts[ev.ch] || 0) + 1;
  const chips = $('chips');
  chips.innerHTML = CHANNELS.map((c) =>
    `<button type="button" class="chip" data-ch="${c.id}" aria-pressed="true" title="${esc(c.hint)}" style="--c:var(${c.color})">` +
    `<i></i>CH${c.no} ${c.name} <small>${num(counts[c.id] || 0)}</small></button>`).join('');
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (on) state.channels.add(b.dataset.ch); else state.channels.delete(b.dataset.ch);
    applyFilter();
  });

  const sel = $('reqFilter');
  sel.innerHTML = '<option value="">all</option>' + [...m.requests.values()].map((r) =>
    `<option value="${r.rid}">#${r.rid} ${esc(r.method)} ${esc(r.url)} ${r.crashed ? '✕ crashed' : r.status ? `→ ${r.status}` : ''}</option>`).join('');
  sel.addEventListener('change', () => {
    state.rid = Number(sel.value) || 0;
    applyFilter();
  });
}

function filterRequest(rid) {
  state.rid = rid;
  $('reqFilter').value = String(rid);
  applyFilter();
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, select, textarea');
  if (e.key === 'Escape' && typing) { e.target.blur(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !state.model) return;
  const keys = {
    j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', J: 'next-delivery', K: 'prev-delivery',
    Home: 'first', End: 'last', c: 'crash',
  };
  if (keys[e.key]) { e.preventDefault(); step(keys[e.key]); return; }
  if (e.key === '/') { e.preventDefault(); $('search').focus(); return; }
  if (e.key === 't') { setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'); return; }
  if (e.key === 's') { inspector.capture(); return; }
  if (e.key === '+' || e.key === '=') { chart.zoom(0.6); return; }
  if (e.key === '-' || e.key === '_') { chart.zoom(1 / 0.6); return; }
  if (e.key === '0') { chart.fit(); chart.setView(...chart.view); return; }
  if (e.key === '1') inspector.setTab('event');
  if (e.key === '2') inspector.setTab('request');
  if (e.key === '3') inspector.setTab('state');
});

// ---------------------------------------------------------------- boot

async function boot() {
  const data = await fetch('/api/recording').then((r) => r.json());
  const m = buildModel(data);
  state.model = m;

  renderLabel(m);
  renderIncident(m);
  renderLegend();
  renderChips(m);

  chart = new StripChart({
    canvas: $('chart'),
    overview: $('overview'),
    tip: $('tip'),
    wrap: $('chartWrap'),
    model: m,
    onSelect: (hit) => {
      if (hit.kind === 'req') {
        select(hit.req.startI);
        inspector.setTab('request');
      } else select(hit.ev.i);
    },
    onView: ([a, b]) => {
      const w = b - a;
      $('zoomRead').textContent = `window ${fmtMs(w)} · 1px ≈ ${fmtMs(w / Math.max(1, chart.plotW))}`;
    },
  });
  chart.onView(chart.view);

  tape = new Tape({ el: $('tape'), spacer: $('tapeSpacer'), model: m, onSelect: (i) => select(i, { scroll: false }) });

  inspector = new Inspector({
    body: $('inspBody'),
    tabs: document.querySelector('.tabs'),
    model: m,
    onSelect: (i) => select(i),
    onFilterRequest: filterRequest,
    snapshot: async (i) => {
      const res = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ until: i }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    },
  });

  document.querySelector('.zoomkeys').addEventListener('click', (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    if (b.dataset.zoom === 'in') chart.zoom(0.6);
    else if (b.dataset.zoom === 'out') chart.zoom(1 / 0.6);
    else { chart.fit(); chart.setView(...chart.view); }
  });

  document.querySelector('.deck').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b) step(b.dataset.step);
  });
  if (!m.crash) document.querySelector('.crash-key').disabled = true;

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim().toLowerCase();
      applyFilter();
    }, 120);
  });

  applyFilter();
  const first = m.crash ? m.crash.i : (m.events.find((e) => e.k === 'http.req') || m.events[0] || {}).i;
  if (first !== undefined) select(first);

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => chart.refreshTheme());
}

boot().catch((err) => {
  $('incident').innerHTML = `<span class="tag">error</span><div><p class="what">Could not load the recording.</p><p class="meta">${esc(err.message)}</p></div>`;
  console.error(err);
});
