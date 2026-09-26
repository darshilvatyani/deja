// The tape: every event as a line of tractor-feed paper. Virtualised, so a
// recording with a hundred thousand events scrolls just as smoothly.

import { CHANNELS } from './model.js';
import { esc, describe, fmtMs, shortSite } from './format.js';

const ROW_H = 24;
const OVERSCAN = 12;
const COLOR = Object.fromEntries([...CHANNELS.map((c) => [c.id, `var(${c.color})`]), ['fault', 'var(--ch-fault)']]);
const NUMBER = Object.fromEntries([...CHANNELS.map((c) => [c.id, c.no]), ['fault', '✕']]);

export class Tape {
  constructor({ el, spacer, model, onSelect }) {
    this.el = el;
    this.spacer = spacer;
    this.model = model;
    this.onSelect = onSelect;
    this.rows = [];
    this.pos = new Map();
    this.selected = null;
    this.pool = [];
    el.addEventListener('scroll', () => this.render());
    spacer.addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (row) this.onSelect(Number(row.dataset.i));
    });
    new ResizeObserver(() => this.render()).observe(el);
  }

  setRows(indices) {
    this.rows = indices;
    this.pos = new Map(indices.map((i, p) => [i, p]));
    this.spacer.style.height = `${indices.length * ROW_H}px`;
    this.render(true);
  }

  select(i, { scroll = true } = {}) {
    this.selected = i;
    if (scroll && this.pos.has(i)) {
      const top = this.pos.get(i) * ROW_H;
      const { scrollTop, clientHeight } = this.el;
      if (top < scrollTop + ROW_H || top > scrollTop + clientHeight - ROW_H * 2) {
        this.el.scrollTop = Math.max(0, top - clientHeight / 2);
      }
    }
    this.render(true);
  }

  render(force) {
    const { scrollTop, clientHeight } = this.el;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((scrollTop + clientHeight) / ROW_H) + OVERSCAN);
    if (!force && this.window && this.window[0] === first && this.window[1] === last) return;
    this.window = [first, last];
    const html = [];
    for (let p = first; p < last; p++) html.push(this.line(this.model.events[this.rows[p]], p));
    this.spacer.innerHTML = html.join('');
  }

  line(ev, p) {
    const cls = ['row', ev.delivery ? 'world' : 'app'];
    if (ev.i === this.selected) cls.push('sel');
    if (ev.k === 'crash') cls.push('crash');
    const site = ev.s ? shortSite(ev.a || ev.s) : '';
    const desc = esc(describe(ev));
    return `<div class="${cls.join(' ')}" data-i="${ev.i}" style="top:${p * ROW_H}px;--c:${COLOR[ev.ch]}" ` +
      `title="${ev.delivery ? 'world → app' : 'app → world'}${site ? ' · ' + esc(ev.a || ev.s) : ''}">` +
      `<span class="n">${ev.i}</span><span class="t">${fmtMs(ev.t)}</span>` +
      `<span class="chip-ch" aria-label="channel ${NUMBER[ev.ch]}"></span>` +
      `<span class="k">${esc(ev.k)}</span>` +
      `<span class="h">${ev.h !== undefined ? `h${ev.h}` : ''}</span>` +
      `<span class="r${ev.rid ? ' on' : ''}">${ev.rid ? `r${ev.rid}` : ''}</span>` +
      `<span class="d">${desc}${site ? ` <em>· ${esc(site)}</em>` : ''}</span></div>`;
  }
}
