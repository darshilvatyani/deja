'use strict';

// The replay scheduler owns the event loop's inputs.
//
// A JS program is deterministic once (1) every nondeterministic value it reads
// is the same and (2) every externally-triggered callback runs in the same
// order. Values are handled by the patches; this loop handles (2): it performs
// exactly one recorded delivery per macrotask, so the microtasks and
// nextTicks it triggers drain completely before the next one — just like they
// did between two real events while recording.

const O = require('./originals');
const tape = require('./tape');

const { S, DELIVERIES } = tape;

const IDLE_LIMIT_MS = 3000;

function start() {
  O.setImmediate(dejaPump);
}

function dejaPump() {
  if (S.done) return;

  const pending = S.pendingSnapshot;
  if (pending && (pending.done || pending.expired)) return tape.finishSnapshot();

  const ev = S.events[S.seq];
  if (!ev) return tape.finish(null, 0);

  if (ev.k === 'crash') {
    return tape.diverge('the recording crashed here, but the replayed app did not throw', ev, { k: 'idle' });
  }

  const handle = DELIVERIES.has(ev.k) ? S.handles.get(ev.h) : null;
  if (!handle) return waitForApp(ev);

  S.seq++;
  S.idleSince = null;
  S.report.counts[ev.k] = (S.report.counts[ev.k] || 0) + 1;
  O.setImmediate(dejaPump);
  if (S.until === ev.i) tape.checkpoint(ev, handle);
  handle.deliver(ev);
  if (S.pendingSnapshot) S.pendingSnapshot.pumpReturned = true;
}

// The cursor points at something the *app* must do next (or at a delivery
// for a handle the app has not created yet). Give unrecorded real work — ESM
// loading, an unpatched fs call — a chance to finish before calling it.
function waitForApp(ev) {
  const now = O.perfNow();
  if (S.progressSeq !== S.seq || S.idleSince === null) {
    S.progressSeq = S.seq;
    S.idleSince = now;
  }
  const waited = now - S.idleSince;
  if (waited > IDLE_LIMIT_MS) {
    const why = DELIVERIES.has(ev.k)
      ? `the recording delivers "${ev.k}" to handle ${ev.h}, but the replayed app never created that handle`
      : `the replayed app went idle, but the recording expected it to produce "${ev.k}"`;
    return tape.diverge(why, ev, { k: 'idle' });
  }
  if (waited < 2) O.setImmediate(dejaPump);
  else O.setTimeout(dejaPump, 4);
}

module.exports = { start };
