// The strip chart: one row per channel, time flowing left to right.
//   ▼ world → app   (a delivery: something the outside pushed in)
//   │ app → world   (something the program did or asked for)
// Math.random() draws a pen trace, like a seismograph of your entropy.

import { CHANNELS } from './model.js';
import { esc, describe, fmtMs, shortSite, bytesOf } from './format.js';

const AXIS = 24;
const ROW = 34;
const RIGHT = 16;

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

function tickLabel(t, step) {
  if (step >= 1000) return `${(t / 1000).toFixed(step >= 10000 ? 0 : 1)}s`;
  if (step >= 1) return `${Math.round(t)}ms`;
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return `${t.toFixed(d)}ms`;
}

export class StripChart {
  constructor({ canvas, overview, tip, wrap, model, onSelect, onView }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ov = overview;
    this.octx = overview.getContext('2d');
    this.tip = tip;
    this.wrap = wrap;
    this.model = model;
    this.onSelect = onSelect;
    this.onView = onView;
    this.events = model.events;
    this.times = Float64Array.from(model.events, (e) => e.t);
    this.selected = null;
    this.hover = null;
    this.match = () => true;
    this.focusRid = 0;
    this.fit();
    this.theme = null;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
  }

  // ---------------------------------------------------------------- geometry

  get reqBand() { return Math.max(34, 14 + this.model.laneCount * 7); }

  layout() {
    const rows = [{ id: 'req', top: AXIS, h: this.reqBand, label: 'REQ', name: 'Requests' }];
    let y = AXIS + this.reqBand;
    for (const ch of CHANNELS) {
      rows.push({ id: ch.id, top: y, h: ROW, label: `CH${ch.no}`, name: ch.name });
      y += ROW;
    }
    this.rows = rows;
    this.rowById = Object.fromEntries(rows.map((r) => [r.id, r]));
    return y + 16;
  }

  fit() {
    const span = Math.max(this.model.span, 1);
    this.view = [-span * 0.01, span * 1.015];
  }

  get plotW() { return this.w - this.g - RIGHT; }

  x(t) { return this.g + ((t - this.view[0]) / (this.view[1] - this.view[0])) * this.plotW; }

  tAt(x) { return this.view[0] + ((x - this.g) / this.plotW) * (this.view[1] - this.view[0]); }

  lowerBound(t) {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(280, this.wrap.clientWidth);
    this.g = this.w < 520 ? 72 : 104;
    this.h = this.layout();
    this.dpr = dpr;
    for (const [cv, h] of [[this.canvas, this.h], [this.ov, 38]]) {
      cv.width = Math.round(this.w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = `${h}px`;
    }
    this.draw();
  }

  refreshTheme() {
    this.theme = null;
    this.draw();
  }

  colors() {
    if (this.theme) return this.theme;
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.theme = {
      paper: v('--paper'), paperHi: v('--paper-hi'), paperLo: v('--paper-lo'),
      rule: v('--rule'), ruleSoft: v('--rule-soft'), grid: v('--grid-major'), gridMinor: v('--grid'),
      ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), hl: v('--hl'),
      in: v('--ch-in'), out: v('--ch-out'), time: v('--ch-time'), rand: v('--ch-rand'), ops: v('--ch-ops'),
      fault: v('--ch-fault'), req: v('--ch-req'), ok: v('--ok'), warn: v('--warn'),
      glow: document.documentElement.dataset.resolvedTheme === 'dark',
      font: v('--font-mono'),
    };
    return this.theme;
  }

  setView(v0, v1, silent) {
    const span = Math.max(this.model.span, 1);
    const minW = Math.max(span / 50000, 0.01);
    let w = Math.max(minW, Math.min(v1 - v0, span * 1.2));
    let a = v0;
    if (v1 - v0 !== w) a = (v0 + v1) / 2 - w / 2;
    a = Math.max(-span * 0.1, Math.min(a, span * 1.1 - w));
    this.view = [a, a + w];
    this.draw();
    if (!silent && this.onView) this.onView(this.view);
  }

  zoom(factor) {
    const [a, b] = this.view;
    const sel = this.selected !== null && this.events[this.selected];
    const mid = sel && sel.t >= a && sel.t <= b ? sel.t : (a + b) / 2;
    this.setView(mid - (mid - a) * factor, mid + (b - mid) * factor);
  }

  reveal(i) {
    const ev = this.events[i];
    if (!ev) return;
    const [a, b] = this.view;
    if (ev.t < a || ev.t > b) {
      const w = b - a;
      this.setView(ev.t - w / 2, ev.t + w / 2);
    }
  }

  // ---------------------------------------------------------------- drawing

  draw() {
    if (!this.w) return;
    const c = this.ctx;
    const col = this.colors();
    const { w: W, h: H } = this;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.paperHi;
    c.fillRect(0, 0, W, H);

    const [v0, v1] = this.view;
    const step = niceStep((v1 - v0) / Math.max(1, this.plotW / 96));

    // minor + major grid, time axis
    c.lineWidth = 1;
    const minor = step / 5;
    c.strokeStyle = col.gridMinor;
    c.beginPath();
    for (let t = Math.ceil(v0 / minor) * minor; t <= v1; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      c.moveTo(x, AXIS);
      c.lineTo(x, H - 6);
    }
    c.stroke();
    c.strokeStyle = col.grid;
    c.fillStyle = col.ink3;
    c.font = `500 9.5px ${col.font}`;
    c.textBaseline = 'middle';
    c.beginPath();
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      c.moveTo(x, AXIS - 5);
      c.lineTo(x, H - 6);
      c.fillText(tickLabel(t, step), x + 3, AXIS - 11);
    }
    c.stroke();

    // row rules + gutter labels
    for (const row of this.rows) {
      c.strokeStyle = col.rule;
      c.beginPath();
      c.moveTo(0, row.top + 0.5);
      c.lineTo(W, row.top + 0.5);
      c.stroke();
      c.fillStyle = row.id === 'req' ? col.ink : col[row.id];
      c.font = `700 9.5px ${col.font}`;
      c.fillText(row.label, 10, row.top + row.h / 2 - 6);
      c.fillStyle = col.ink3;
      c.font = `400 9.5px ${col.font}`;
      c.fillText(row.name.toUpperCase(), 10, row.top + row.h / 2 + 7);
    }
    const bottom = this.rows[this.rows.length - 1];
    c.strokeStyle = col.rule;
    c.beginPath();
    c.moveTo(0, bottom.top + bottom.h + 0.5);
    c.lineTo(W, bottom.top + bottom.h + 0.5);
    c.moveTo(this.g - 0.5, AXIS);
    c.lineTo(this.g - 0.5, bottom.top + bottom.h);
    c.stroke();

    c.save();
    c.beginPath();
    c.rect(this.g, 0, this.plotW + RIGHT, H);
    c.clip();

    this.drawRequests(c, col);
    this.drawTimerWaits(c, col);
    this.drawEvents(c, col);
    this.drawMarkers(c, col);
    c.restore();

    this.drawOverview();
  }

  drawRequests(c, col) {
    const band = this.rowById.req;
    const [v0, v1] = this.view;
    for (const r of this.model.requests.values()) {
      const end = r.end ?? this.model.span;
      if (end < v0 || r.start > v1) continue;
      const x0 = this.x(r.start);
      const x1 = Math.max(x0 + 2, this.x(end));
      const y = band.top + 7 + r.lane * 7;
      const dimmed = this.focusRid && this.focusRid !== r.rid;
      c.globalAlpha = dimmed ? 0.18 : 1;
      let color = col.req;
      if (r.crashed) color = col.fault;
      else if (r.status >= 500) color = col.fault;
      else if (r.status >= 400) color = col.time;
      c.fillStyle = color;
      c.strokeStyle = color;
      if (r.end === null) {
        c.setLineDash([3, 2]);
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(x0, y + 2);
        c.lineTo(x1, y + 2);
        c.stroke();
        c.setLineDash([]);
      } else if (r.status >= 400 && r.status < 500) {
        c.lineWidth = 1;
        c.strokeRect(x0 + 0.5, y + 0.5, x1 - x0, 3.5);
      } else {
        c.fillRect(x0, y, x1 - x0, 4.5);
      }
      c.fillRect(x0 - 0.5, y - 1.5, 1.5, 7.5);
      if (this.focusRid === r.rid) {
        c.fillStyle = col.ink;
        c.font = `700 9px ${col.font}`;
        c.fillText(`#${r.rid}`, x1 + 4, y + 2);
      }
    }
    c.globalAlpha = 1;
  }

  drawTimerWaits(c, col) {
    const row = this.rowById.time;
    const [v0, v1] = this.view;
    const i0 = this.lowerBound(v0);
    const i1 = this.lowerBound(v1 + (v1 - v0));
    c.strokeStyle = col.time;
    c.lineWidth = 1;
    c.globalAlpha = 0.32;
    c.beginPath();
    for (let i = i0; i < i1 && i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.k !== 'timer' || !ev.timer || ev.timer.repeat) continue;
      const set = this.events[ev.timer.set];
      if (!set || !this.match(ev)) continue;
      const y = row.top + row.h - 7 - ((ev.h % 4) * 3);
      c.moveTo(this.x(set.t), y + 0.5);
      c.lineTo(this.x(ev.t), y + 0.5);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  drawEvents(c, col) {
    const [v0, v1] = this.view;
    const pad = (v1 - v0) * 0.01;
    const i0 = this.lowerBound(v0 - pad);
    const i1 = this.lowerBound(v1 + pad);

    // entropy pen trace first (under the marks)
    const rrow = this.rowById.rand;
    c.lineWidth = 1;
    c.strokeStyle = col.rand;
    c.globalAlpha = 0.55;
    if (col.glow) { c.shadowColor = col.rand; c.shadowBlur = 5; }
    c.beginPath();
    let pen = false;
    for (let i = i0; i < i1; i++) {
      const ev = this.events[i];
      if (ev.k !== 'random' || !this.match(ev)) continue;
      const x = this.x(ev.t);
      const y = rrow.top + 4 + (1 - ev.v) * (rrow.h - 8);
      if (!pen) { c.moveTo(x, y); pen = true; } else c.lineTo(x, y);
    }
    c.stroke();
    c.shadowBlur = 0;
    c.globalAlpha = 1;

    for (let i = i0; i < i1; i++) {
      const ev = this.events[i];
      const row = this.rowById[ev.ch];
      if (!row) continue;
      const on = this.match(ev);
      c.globalAlpha = on ? 1 : 0.13;
      const color = col[ev.ch];
      c.fillStyle = color;
      c.strokeStyle = color;
      const x = Math.round(this.x(ev.t)) + 0.5;
      if (ev.k === 'random') {
        const y = row.top + 4 + (1 - ev.v) * (row.h - 8);
        c.fillRect(x - 1.5, y - 1.5, 3, 3);
        continue;
      }
      if (ev.delivery) {
        const top = row.top + 4;
        c.beginPath();
        c.moveTo(x - 3.5, top);
        c.lineTo(x + 3.5, top);
        c.lineTo(x, top + 5);
        c.closePath();
        c.fill();
        let stem = 9;
        if (ev.k === 'sock.data') {
          const b = bytesOf(ev.v);
          stem = 6 + Math.min(14, Math.log2((b ? b.length : 1) + 1) * 1.4);
        }
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, top + 5);
        c.lineTo(x, top + 5 + stem);
        c.stroke();
      } else {
        let hgt = 8;
        if (ev.k === 'sock.write') {
          const b = bytesOf(ev.v);
          hgt = 5 + Math.min(16, Math.log2((b ? b.length : 1) + 1) * 1.5);
        } else if (ev.k === 'http.req' || ev.k === 'http.res' || ev.k === 'sock.connect' || ev.k === 'srv.listen') hgt = 16;
        const base = row.top + row.h - 4;
        c.lineWidth = ev.k === 'http.req' || ev.k === 'http.res' ? 2 : 1;
        c.beginPath();
        c.moveTo(x, base);
        c.lineTo(x, base - hgt);
        c.stroke();
        if (ev.k === 'sock.connect' || ev.k === 'srv.listen') {
          c.beginPath();
          c.arc(x, base - hgt, 2.5, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    c.globalAlpha = 1;
  }

  drawMarkers(c, col) {
    const H = this.rows[this.rows.length - 1].top + ROW;
    const crash = this.model.crash;
    if (crash) {
      const x = Math.round(this.x(crash.t)) + 0.5;
      c.strokeStyle = col.fault;
      c.lineWidth = 2;
      if (col.glow) { c.shadowColor = col.fault; c.shadowBlur = 8; }
      c.beginPath();
      c.moveTo(x, AXIS);
      c.lineTo(x, H);
      c.stroke();
      c.shadowBlur = 0;
      c.save();
      c.translate(x - 6, AXIS + 6);
      c.rotate(-0.06);
      c.font = `700 10px ${col.font}`;
      const label = `✕ CRASH #${crash.i}`;
      const tw = c.measureText(label).width;
      c.fillStyle = col.paperHi;
      c.fillRect(-tw - 12, -2, tw + 10, 16);
      c.strokeStyle = col.fault;
      c.lineWidth = 1.5;
      c.strokeRect(-tw - 12, -2, tw + 10, 16);
      c.fillStyle = col.fault;
      c.fillText(label, -tw - 7, 6.5);
      c.restore();
    }
    if (this.selected !== null && this.events[this.selected]) {
      const ev = this.events[this.selected];
      const x = Math.round(this.x(ev.t)) + 0.5;
      c.strokeStyle = col.ink;
      c.lineWidth = 1;
      c.setLineDash([2, 2]);
      c.beginPath();
      c.moveTo(x, AXIS);
      c.lineTo(x, H);
      c.stroke();
      c.setLineDash([]);
      const row = this.rowById[ev.ch] || this.rowById.req;
      c.strokeStyle = col.ink;
      c.lineWidth = 1.5;
      c.strokeRect(x - 6, row.top + 2, 12, row.h - 4);
      c.font = `700 9.5px ${col.font}`;
      const label = `#${ev.i}`;
      const tw = c.measureText(label).width;
      c.fillStyle = col.ink;
      c.fillRect(x - tw / 2 - 5, H - 1, tw + 10, 13);
      c.fillStyle = col.paperHi;
      c.fillText(label, x - tw / 2, H + 5.5);
    }
    if (this.hover && this.hover.x !== undefined) {
      c.strokeStyle = col.ink3;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(this.hover.x + 0.5, AXIS);
      c.lineTo(this.hover.x + 0.5, H);
      c.stroke();
    }
  }

  drawOverview() {
    const c = this.octx;
    const col = this.colors();
    const W = this.w;
    const H = 38;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.paperLo;
    c.fillRect(0, 0, W, H);
    const span = Math.max(this.model.span, 1);
    const ox = (t) => this.g + (t / span) * this.plotW;
    const bins = Math.max(1, Math.floor(this.plotW / 3));
    const counts = new Uint32Array(bins);
    const hits = new Uint32Array(bins);
    for (const ev of this.events) {
      const b = Math.min(bins - 1, Math.floor((ev.t / span) * bins));
      counts[b]++;
      if (this.focusRid ? ev.rid === this.focusRid : ev.delivery) hits[b]++;
    }
    const max = Math.max(1, ...counts);
    for (let b = 0; b < bins; b++) {
      if (!counts[b]) continue;
      const x = this.g + (b / bins) * this.plotW;
      const h = Math.sqrt(counts[b] / max) * (H - 8);
      c.fillStyle = col.ink3;
      c.fillRect(x, H - 3 - h, 2, h);
      if (hits[b]) {
        const hh = Math.sqrt(hits[b] / max) * (H - 8);
        c.fillStyle = this.focusRid ? col.rand : col.in;
        c.fillRect(x, H - 3 - hh, 2, hh);
      }
    }
    if (this.model.crash) {
      c.fillStyle = col.fault;
      c.fillRect(ox(this.model.crash.t) - 1, 0, 2, H);
    }
    const a = ox(Math.max(0, this.view[0]));
    const b = ox(Math.min(span, this.view[1]));
    c.fillStyle = col.paperHi;
    c.globalAlpha = 0.6;
    c.fillRect(this.g, 0, Math.max(0, a - this.g), H);
    c.fillRect(b, 0, Math.max(0, this.g + this.plotW - b), H);
    c.globalAlpha = 1;
    c.strokeStyle = col.ink;
    c.lineWidth = 1.5;
    c.strokeRect(a + 0.5, 1, Math.max(3, b - a), H - 2);
    c.fillStyle = col.ink3;
    c.font = `500 9px ${col.font}`;
    c.textBaseline = 'middle';
    c.fillText('OVERVIEW', 10, H / 2);
  }

  // ---------------------------------------------------------------- picking

  rowAt(y) {
    return this.rows.find((r) => y >= r.top && y < r.top + r.h) || null;
  }

  pick(x, y) {
    const row = this.rowAt(y);
    if (!row || x < this.g) return null;
    const t = this.tAt(x);
    if (row.id === 'req') {
      const lane = Math.floor((y - row.top - 5) / 7);
      let best = null;
      for (const r of this.model.requests.values()) {
        if (r.lane !== lane) continue;
        const end = r.end ?? this.model.span;
        const slack = (this.view[1] - this.view[0]) * (4 / this.plotW);
        if (t >= r.start - slack && t <= end + slack) { best = r; break; }
      }
      return best ? { kind: 'req', req: best } : null;
    }
    const dt = (this.view[1] - this.view[0]) * (9 / this.plotW);
    const i0 = this.lowerBound(t - dt);
    const i1 = this.lowerBound(t + dt);
    let best = null;
    let bestD = Infinity;
    for (let i = i0; i < i1; i++) {
      const ev = this.events[i];
      if (ev.ch !== row.id || !this.match(ev)) continue;
      const d = Math.abs(ev.t - t);
      if (d < bestD) { bestD = d; best = ev; }
    }
    if (!best && this.model.crash && Math.abs(this.x(this.model.crash.t) - x) < 6) best = this.model.crash;
    return best ? { kind: 'ev', ev: best } : null;
  }

  showTip(hit, x, y) {
    const tip = this.tip;
    if (!hit) { tip.hidden = true; return; }
    if (hit.kind === 'req') {
      const r = hit.req;
      const dur = r.end !== null ? fmtMs(r.end - r.start) : 'never answered';
      tip.innerHTML = `<b>request #${r.rid}</b> · ${esc(r.method)} ${esc(r.url)}<br>` +
        `${r.crashed ? '<b style="color:var(--ch-fault)">crashed the process</b>' : r.status ? `→ ${r.status}` : '—'} · ${dur}`;
    } else {
      const ev = hit.ev;
      tip.innerHTML = `<b>#${ev.i} ${esc(ev.k)}</b> · ${fmtMs(ev.t)}${ev.rid ? ` · req #${ev.rid}` : ''}<br>${esc(describe(ev).slice(0, 110))}` +
        (ev.s ? `<span class="s">${esc(shortSite(ev.a || ev.s))}</span>` : '');
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = x + 14 + tw > this.w ? x - tw - 14 : x + 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, y - 10)}px`;
  }

  // ---------------------------------------------------------------- input

  bind() {
    const cv = this.canvas;
    let drag = null;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    cv.addEventListener('wheel', (e) => {
      const [x] = pos(e);
      const [v0, v1] = this.view;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const dt = (e.deltaX / this.plotW) * (v1 - v0);
        this.setView(v0 + dt, v1 + dt);
        return;
      }
      // plain vertical scrolling belongs to the page; ⌘/ctrl (and pinch) zoom
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      const t = this.tAt(Math.max(this.g, x));
      const f = Math.exp(e.deltaY * 0.0022);
      this.setView(t - (t - v0) * f, t + (v1 - t) * f);
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      drag = { x, y, v: [...this.view], moved: false, id: e.pointerId };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (drag) {
        const dx = x - drag.x;
        if (Math.abs(dx) > 3) drag.moved = true;
        if (drag.moved) {
          cv.classList.add('dragging');
          this.tip.hidden = true;
          const dt = (dx / this.plotW) * (drag.v[1] - drag.v[0]);
          this.setView(drag.v[0] - dt, drag.v[1] - dt);
        }
        return;
      }
      this.hover = { x };
      const hit = this.pick(x, y);
      this.showTip(hit, x, y);
      this.draw();
    });
    cv.addEventListener('pointerup', (e) => {
      const [x, y] = pos(e);
      cv.classList.remove('dragging');
      if (drag && !drag.moved) {
        const hit = this.pick(x, y);
        if (hit && this.onSelect) this.onSelect(hit);
      }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
    cv.addEventListener('dblclick', () => {
      this.fit();
      this.setView(...this.view);
    });

    let odrag = false;
    const moveOverview = (e) => {
      const r = this.ov.getBoundingClientRect();
      const x = e.clientX - r.left;
      const t = ((x - this.g) / this.plotW) * Math.max(this.model.span, 1);
      const w = this.view[1] - this.view[0];
      this.setView(t - w / 2, t + w / 2);
    };
    this.ov.addEventListener('pointerdown', (e) => { odrag = true; this.ov.setPointerCapture(e.pointerId); moveOverview(e); });
    this.ov.addEventListener('pointermove', (e) => { if (odrag) moveOverview(e); });
    this.ov.addEventListener('pointerup', () => { odrag = false; });
  }
}
