// §3 Inspector: what one event was, the story of the request it belongs to,
// and the program's state at that exact moment (captured by re-running the
// replay up to the event and pausing inside the app).

import { CHANNELS } from './model.js';
import { esc, describe, fmtMs, fmtBytes, bytesOf, latin1, hexdump, parseHttp, parseSite, shortSite, num } from './format.js';

const CH = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));
const colorOf = (ch) => (ch === 'fault' ? 'var(--ch-fault)' : `var(${CH[ch].color})`);

const sourceCache = new Map();

async function fetchSource(file, line) {
  const key = `${file}:${line}`;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, fetch(`/api/source?file=${encodeURIComponent(file)}&line=${line}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return sourceCache.get(key);
}

function sourceHtml(src) {
  if (!src) return '';
  return `<p class="src-path">${esc(src.file)}</p><div class="code src">${src.lines.map((l, k) => {
    const no = src.start + k;
    return `<div class="ln${no === src.line ? ' here' : ''}"><span class="no">${no}</span><span>${esc(l) || ' '}</span></div>`;
  }).join('')}</div>`;
}

function fmtVar(v) {
  if (!v) return { cls: 'und', text: 'undefined' };
  if (v.type === 'string') return { cls: 'str', text: JSON.stringify(v.value) };
  if (v.type === 'number' || v.type === 'bigint' || v.type === 'boolean') return { cls: 'num', text: String(v.value) };
  if (v.type === 'undefined') return { cls: 'und', text: 'undefined' };
  if (v.type === 'accessor') return { cls: 'und', text: '(getter)' };
  if (v.subtype === 'null') return { cls: 'und', text: 'null' };
  if (v.type === 'function') return { cls: 'obj', text: `ƒ ${(v.desc || '').split('\n')[0].slice(0, 70)}` };
  if (v.preview && v.preview.props) {
    const isArray = v.subtype === 'array';
    const inner = v.preview.props.map((p) => {
      const val = p.type === 'string' ? JSON.stringify(p.value) : p.value ?? p.subtype ?? p.type;
      return isArray ? val : `${p.name}: ${val}`;
    });
    if (v.preview.overflow) inner.push('…');
    const label = v.desc && v.desc !== 'Object' && !isArray ? `${v.desc} ` : '';
    return { cls: 'obj', text: isArray ? `${v.desc || ''} [${inner.join(', ')}]` : `${label}{${inner.join(', ')}}` };
  }
  return { cls: 'obj', text: v.desc || v.type };
}

export class Inspector {
  constructor({ body, tabs, model, onSelect, onFilterRequest, snapshot }) {
    this.body = body;
    this.tabs = tabs;
    this.model = model;
    this.onSelect = onSelect;
    this.onFilterRequest = onFilterRequest;
    this.snapshot = snapshot;
    this.tab = 'event';
    this.current = null;
    this.byteView = null;
    this.snapshots = new Map();
    this.follow = false;

    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.setTab(b.dataset.tab);
    });
    body.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const a = t.dataset.action;
      if (a === 'select') this.onSelect(Number(t.dataset.i));
      else if (a === 'bytes') { this.byteView = t.dataset.view; this.render(); }
      else if (a === 'story') { this.setTab('request'); }
      else if (a === 'filter-req') this.onFilterRequest(Number(t.dataset.rid));
      else if (a === 'state') this.capture();
      else if (a === 'follow') { this.follow = !this.follow; if (this.follow) this.capture(); else this.render(); }
    });
  }

  setTab(tab) {
    this.tab = tab;
    for (const b of this.tabs.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    this.render();
    if (tab === 'state' && this.follow) this.capture();
  }

  show(i) {
    this.current = i;
    this.byteView = null;
    if (this.tab === 'state' && this.follow) this.capture();
    this.render();
  }

  render() {
    const ev = this.model.events[this.current];
    if (!ev) {
      this.body.innerHTML = '<p class="empty">Pick an event on the chart or the tape.</p>';
      return;
    }
    if (this.tab === 'event') this.renderEvent(ev);
    else if (this.tab === 'request') this.renderStory(ev);
    else this.renderState(ev);
    this.body.scrollTop = 0;
  }

  // ------------------------------------------------------------------ event

  handleFacts(ev) {
    const m = this.model;
    const facts = [];
    if (ev.h === undefined) return facts;
    const s = m.sockets.get(ev.h);
    if (s) {
      facts.push(['handle', `h${ev.h} · ${s.side === 'server' ? `server socket (${esc(s.label)})` : `client socket → ${esc(s.label)}`} · opened at <button class="linkish" data-action="select" data-i="${s.first}">#${s.first}</button>`]);
    } else if (m.timers.has(ev.h)) {
      const t = m.timers.get(ev.h);
      const set = m.events[t.set];
      let extra = '';
      if (ev.k === 'timer' && set) extra = ` · waited ${fmtMs(ev.t - set.t)}`;
      facts.push(['handle', `h${ev.h} · ${t.repeat ? 'interval' : 'timeout'} of ${t.ms} ms, set at <button class="linkish" data-action="select" data-i="${t.set}">#${t.set}</button>${extra}`]);
      if (t.site && ev.k !== 'timer.set') facts.push(['scheduled by', esc(t.site)]);
    } else if (ev.h === 0) {
      facts.push(['handle', 'h0 · the process (signals)']);
    } else {
      facts.push(['handle', `h${ev.h}`]);
    }
    return facts;
  }

  tidyStack(stack) {
    const cwd = (this.model.header.cwd || '') + '/';
    return String(stack || '').replaceAll(`file://${cwd}`, '').replaceAll(cwd, '');
  }

  // the first frame of the crash stack that is the app's own code
  crashSite(ev) {
    const cwd = (this.model.header.cwd || '') + '/';
    for (const m of String(ev.v.stack || '').matchAll(/\(?(?:file:\/\/)?(\/[^():]+):(\d+):(\d+)\)?/g)) {
      const abs = m[1];
      if (!abs.startsWith(cwd) || abs.includes('/node_modules/') || abs.includes('/packages/runtime/')) continue;
      return `${abs.slice(cwd.length)}:${m[2]}:${m[3]}`;
    }
    return null;
  }

  renderValue(ev) {
    const v = ev.v;
    if (ev.k === 'crash') {
      return `<div class="subhead">thrown · ${esc(v.origin || 'uncaught')}</div><p class="note" style="color:var(--ch-fault)">${esc(v.name)}: ${esc(v.message)}</p>` +
        `<pre class="wrap">${esc(this.tidyStack(v.stack))}</pre>`;
    }
    const bytes = bytesOf(v);
    if (bytes && (ev.k === 'sock.data' || ev.k === 'sock.write')) {
      const text = latin1(bytes, 64 * 1024);
      const http = parseHttp(text);
      const view = this.byteView || (http ? 'http' : 'text');
      const seg = ['http', 'text', 'hex']
        .filter((x) => x !== 'http' || http)
        .map((x) => `<button type="button" data-action="bytes" data-view="${x}" aria-pressed="${x === view}">${x}</button>`).join('');
      let out = '';
      if (view === 'http' && http) {
        out = `<pre class="http wrap"><span class="start">${esc(http.start)}</span>\n${http.headers.map(([k, val]) => `<span class="hk">${esc(k)}:</span> ${esc(val)}`).join('\n')}` +
          `${http.body ? `\n\n<span class="body">${esc(http.body.slice(0, 4000))}</span>` : ''}</pre>`;
      } else if (view === 'hex') out = `<pre>${esc(hexdump(bytes))}</pre>`;
      else out = `<pre class="wrap">${esc(text.slice(0, 8000))}</pre>`;
      return `<div class="subhead">${ev.k === 'sock.data' ? 'bytes received' : 'bytes sent'} · ${fmtBytes(bytes.length)} <span class="seg">${seg}</span></div>${out}`;
    }
    if (bytes) return `<div class="subhead">bytes</div><pre>${esc(hexdump(bytes, 256))}</pre>`;
    if (v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'string') {
      return `<div class="subhead">value ${ev.delivery ? 'delivered' : 'returned to the app'}</div><p class="note" style="font-style:normal;font-family:var(--font-mono);font-size:18px;color:var(--ink)">${esc(describe(ev))}</p>`;
    }
    return `<div class="subhead">payload</div><pre class="wrap">${esc(JSON.stringify(v, null, 2))}</pre>`;
  }

  renderEvent(ev) {
    const m = this.model;
    const chName = ev.ch === 'fault' ? 'fault' : `CH${CH[ev.ch].no} ${CH[ev.ch].name.toLowerCase()}`;
    const facts = [
      ['at', `${fmtMs(ev.t)} after the process started`],
      ['channel', `${chName}`],
      ...this.handleFacts(ev),
    ];
    if (ev.rid && m.requests.has(ev.rid)) {
      const r = m.requests.get(ev.rid);
      facts.push(['request', `<button class="linkish" data-action="story">#${r.rid} ${esc(r.method)} ${esc(r.url)}</button> ${r.crashed ? '· crashed' : r.status ? `→ ${r.status}` : ''}${ev.guess ? ' <span class="hint">(attributed by socket)</span>' : ''}`]);
    }
    if (ev.s) facts.push(['call site', `${esc(ev.s)}${ev.a ? `<br><span class="hint">in your code: ${esc(ev.a)}</span>` : ''}`]);

    const flow = ev.k === 'crash' ? 'uncaught · the process died here'
      : ev.delivery ? 'world → app · replayed by the scheduler' : 'app → world · verified on replay';
    const site = parseSite(ev.k === 'crash' ? this.crashSite(ev) : ev.a || ev.s);
    this.body.innerHTML =
      `<div class="ev-head" style="--c:${colorOf(ev.ch)}"><span class="num">#${ev.i}</span><span class="kind">${esc(ev.k)}</span><span class="flow">${flow}</span></div>` +
      `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
      this.renderValue(ev) +
      `<div class="subhead">time travel</div>` +
      `<div class="cta"><button type="button" class="btn primary" data-action="state">Replay to #${ev.i} ⟲</button>` +
      `<span class="hint">re-runs the recording up to this event and pauses ${ev.delivery ? 'at the first line of your code it triggers' : 'right where your code caused it'}</span></div>` +
      (site && site.file ? '<div class="subhead">source</div><div id="srcSlot"><div class="loading"><span class="meter"></span></div></div>' : '');

    if (site && site.file) {
      const at = this.current;
      fetchSource(site.file, site.line).then((src) => {
        if (this.current !== at || this.tab !== 'event') return;
        const slot = this.body.querySelector('#srcSlot');
        if (slot) slot.innerHTML = src ? sourceHtml(src) : '<p class="hint">source not available</p>';
      });
    }
  }

  // ------------------------------------------------------------------ story

  renderStory(ev) {
    const m = this.model;
    const rid = ev.rid;
    if (!rid || !m.requests.has(rid)) {
      const list = [...m.requests.values()].slice(0, 400).map((r) =>
        `<li style="--c:${r.crashed || r.status >= 500 ? 'var(--ch-fault)' : r.status >= 400 ? 'var(--ch-time)' : 'var(--ch-in)'}" data-action="select" data-i="${r.startI}">` +
        `<span class="dt">#${r.rid}</span><span class="what"><b>${esc(r.method)} ${esc(r.url)}</b> ${r.crashed ? 'crashed' : r.status ? `→ ${r.status}` : '—'}` +
        `<small>${fmtMs(r.start)} · ${r.end !== null ? fmtMs(r.end - r.start) : 'never answered'}</small></span></li>`).join('');
      this.body.innerHTML = `<p class="note">Event #${ev.i} is not part of an HTTP request. Pick one of the ${num(m.requests.size)} requests:</p>` +
        (list ? `<ol class="story">${list}</ol>` : '<p class="empty">This recording has no inbound HTTP requests.</p>');
      return;
    }
    const r = m.requests.get(rid);
    const stamp = r.crashed ? '<span class="stamp bad small">crashed</span>'
      : r.status >= 500 ? `<span class="stamp bad small">${r.status}</span>`
        : r.status >= 400 ? `<span class="stamp info small">${r.status}</span>`
          : r.status ? `<span class="stamp ok small">${r.status}</span>` : '<span class="stamp bad small">no reply</span>';
    const items = r.events.map((i) => {
      const e = m.events[i];
      const cls = [e.delivery ? 'world' : 'app', e.i === ev.i ? 'sel' : '', e.guess ? 'guess' : ''].join(' ');
      const d = e.t - r.start;
      return `<li class="${cls}" style="--c:${colorOf(e.ch)}" data-action="select" data-i="${e.i}">` +
        `<span class="dt">${d >= 0 ? '+' : ''}${fmtMs(d)}</span>` +
        `<span class="what"><b>${esc(e.k)}</b> ${esc(describe(e).slice(0, 80))}<small>#${e.i}${e.s ? ` · ${esc(shortSite(e.a || e.s))}` : ''}</small></span></li>`;
    }).join('');
    this.body.innerHTML =
      `<div class="story-head"><div><div class="title">Request #${r.rid} · ${esc(r.method)} ${esc(r.url)}</div>` +
      `<div class="hint">${r.events.length} events · ${r.end !== null ? `answered in ${fmtMs(r.end - r.start)}` : 'never answered'} · ` +
      `<button class="linkish" data-action="filter-req" data-rid="${r.rid}">show only this request</button></div></div>${stamp}</div>` +
      `<ol class="story">${items}</ol>` +
      '<p class="hint" style="margin-top:12px">● world → app &nbsp; ○ app → world &nbsp; ≈ attributed by socket (shared connection)</p>';
  }

  // ------------------------------------------------------------------ state

  async capture() {
    const i = this.current;
    if (i === null || i === undefined) return;
    if (this.tab !== 'state') this.setTab('state');
    if (this.snapshots.has(i)) { this.render(); return; }
    this.snapshots.set(i, { loading: true });
    this.render();
    try {
      const res = await this.snapshot(i);
      this.snapshots.set(i, res);
    } catch (err) {
      this.snapshots.set(i, { error: err.message });
    }
    if (this.current === i && this.tab === 'state') this.render();
  }

  renderState(ev) {
    const snap = this.snapshots.get(ev.i);
    const followBtn = `<button type="button" class="chip" data-action="follow" aria-pressed="${this.follow}"><i style="--c:var(--ch-rand)"></i>follow selection</button>`;
    if (!snap) {
      this.body.innerHTML =
        `<p class="note">What did the program look like at event #${ev.i}?</p>` +
        `<p class="hint">déjà re-runs the recording in a fresh process — no network, virtual clock — stops at #${ev.i} and reads the call stack and local variables with the inspector.</p>` +
        `<div class="cta" style="margin-top:14px"><button type="button" class="btn primary" data-action="state">Replay to #${ev.i} ⟲</button>${followBtn}</div>`;
      return;
    }
    if (snap.loading) {
      this.body.innerHTML = `<div class="loading"><span class="meter"></span> replaying ${num(ev.i + 1)} events to reach #${ev.i}…</div>`;
      return;
    }
    if (snap.error || !snap.snapshot) {
      const d = snap.divergence;
      this.body.innerHTML = `<p class="note" style="color:var(--bad)">Could not capture state: ${esc(snap.error || (d ? d.message : snap.status || 'unknown'))}</p>`;
      return;
    }
    const s = snap.snapshot;
    const frames = s.frames || [];
    const top = frames.find((f) => f.scopes) || frames.find((f) => f.kind === 'app') || frames[0];
    const how = s.mode === 'step-into'
      ? `stepped ${num(s.steps)} statements from the delivery into the first line of your code`
      : s.mode === 'at-throw' ? 'paused at the throw, before the stack unwound'
        : 'paused where your code produced this event';
    let html = `<div class="story-head"><div><div class="title">${top ? `${esc(top.fn)}() · ${esc(top.rel || top.file)}:${top.line}` : 'no frames'}</div>` +
      `<div class="hint">${how} · captured in ${fmtMs(snap.ms)}</div></div>${followBtn}</div>`;
    if (s.note) html += `<p class="note">${esc(s.note)}</p>`;
    if (top && top.kind === 'app') html += '<div id="stateSrc"></div>';
    const detailed = frames.filter((f) => f.scopes);
    for (const [k, f] of detailed.entries()) {
      html += `<div class="subhead">${k === 0 ? 'variables' : `caller: ${esc(f.fn)}()`}</div>`;
      for (const [si, scope] of f.scopes.entries()) {
        const rows = scope.vars.map((v) => {
          const { cls, text } = fmtVar(v);
          return `<span class="vn">${esc(v.name)}</span><span class="vv ${cls}">${esc(text)}</span>`;
        }).join('');
        html += `<details class="scope" ${k === 0 && si < 2 ? 'open' : ''}><summary>${esc(scope.type)}${scope.name ? ` · ${esc(scope.name)}` : ''} · ${scope.vars.length}</summary>` +
          `<div class="vars">${rows || '<span class="vv und">(empty)</span>'}</div></details>`;
      }
    }
    html += '<div class="subhead">call stack</div><ul class="frames">' + frames.slice(0, 30).map((f) =>
      `<li class="${f.kind}"><span class="fk">${f.kind}</span><span>${esc(f.fn)}</span><span class="loc">${esc(f.rel || f.file)}:${f.line}</span></li>`).join('') + '</ul>';
    this.body.innerHTML = html;

    if (top && top.kind === 'app' && top.rel) {
      fetchSource(top.rel, top.line).then((src) => {
        const slot = this.body.querySelector('#stateSrc');
        if (slot && src) slot.innerHTML = sourceHtml(src);
      });
    }
  }
}
