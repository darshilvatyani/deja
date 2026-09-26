'use strict';

// Timers become handles. Creating/clearing one is a structural event; the
// moment it fires is a delivery. When recording, a real timer drives the
// delivery. When replaying there is no real timer at all: the clock is
// virtual, and the scheduler fires handles in the recorded order, so an hour
// of wall time replays in milliseconds.

const timers = require('node:timers');
const timersPromises = require('node:timers/promises');
const { AsyncResource } = require('node:async_hooks');
const O = require('../originals');
const tape = require('../tape');

class Timeout {
  constructor(id, kind, callback, args, ms) {
    this.id = id;
    this.kind = kind; // 'timeout' | 'interval' | 'immediate'
    this.ctx = tape.ctx();
    this._callback = callback;
    this._args = args;
    this._idleTimeout = ms;
    this._onTimeout = callback;
    this._resource = new AsyncResource(kind === 'immediate' ? 'Immediate' : 'Timeout');
    this._real = null;
    this._ref = true;
    this._cleared = false;
    this._fired = false;
  }

  deliver() {
    if (this.kind !== 'interval') {
      this._fired = true;
      tape.unregister(this.id);
    }
    return this._resource.runInAsyncScope(this._callback, this, ...this._args);
  }

  ref() {
    this._ref = true;
    if (this._real && this._real.ref) this._real.ref();
    return this;
  }

  unref() {
    this._ref = false;
    if (this._real && this._real.unref) this._real.unref();
    return this;
  }

  hasRef() {
    return this._ref;
  }

  refresh() {
    if (this.kind === 'immediate' || this._cleared) return this;
    if (this._real) this._real.refresh();
    if (this._fired) {
      // Node re-arms a timeout that already fired when refreshed.
      this._fired = false;
      tape.register(this);
    }
    return this;
  }

  close() {
    clear(this);
    return this;
  }

  [Symbol.toPrimitive]() {
    return this.id;
  }

  [Symbol.dispose]() {
    clear(this);
  }
}

function normalizeMs(ms) {
  const n = Number(ms);
  return n >= 1 && n <= 2147483647 ? n : 1;
}

function create(kind, callback, ms, args) {
  const id = tape.allocHandle();
  const timer = new Timeout(id, kind, callback, args, ms);
  if (kind === 'immediate') tape.mark('immediate.set', id);
  else tape.mark('timer.set', id, { ms: normalizeMs(ms), repeat: kind === 'interval' });
  tape.register(timer);

  if (tape.recording()) {
    const eventKind = kind === 'immediate' ? 'immediate' : 'timer';
    const fire = () => tape.deliver(timer, eventKind);
    if (kind === 'timeout') timer._real = O.setTimeout(fire, ms);
    else if (kind === 'interval') timer._real = O.setInterval(fire, ms);
    else timer._real = O.setImmediate(fire);
  }
  return timer;
}

function clear(timer) {
  if (timer instanceof Timeout) {
    if (timer._cleared) return;
    timer._cleared = true;
    const pending = timer.kind === 'interval' || !timer._fired;
    if (pending) {
      tape.mark('timer.clear', timer.id, undefined, { site: false });
      tape.unregister(timer.id);
    }
    if (timer._real) {
      if (timer.kind === 'immediate') O.clearImmediate(timer._real);
      else O.clearTimeout(timer._real);
    }
    return;
  }
  if (typeof timer === 'number' || typeof timer === 'string') {
    const handle = tape.S.handles.get(Number(timer));
    if (handle instanceof Timeout) return clear(handle);
  }
  if (timer) O.clearTimeout(timer);
}

function setTimeout(callback, ms, ...args) {
  if (typeof callback !== 'function' || !tape.active()) return O.setTimeout(callback, ms, ...args);
  return create('timeout', callback, ms, args);
}

function setInterval(callback, ms, ...args) {
  if (typeof callback !== 'function' || !tape.active()) return O.setInterval(callback, ms, ...args);
  return create('interval', callback, ms, args);
}

function setImmediate(callback, ...args) {
  if (typeof callback !== 'function' || !tape.active()) return O.setImmediate(callback, ...args);
  return create('immediate', callback, 0, args);
}

function clearTimeout(timer) { clear(timer); }
function clearInterval(timer) { clear(timer); }
function clearImmediate(timer) {
  if (timer instanceof Timeout) return clear(timer);
  if (timer) O.clearImmediate(timer);
}

// --------------------------------------------------------- timers/promises

function abortError(signal) {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  if (signal) err.cause = signal.reason;
  return err;
}

function promised(schedule, value, options = {}) {
  const { signal, ref = true } = options;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal));
    let timer = null;
    const onAbort = () => {
      clear(timer);
      reject(abortError(signal));
    };
    timer = schedule(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
    if (!ref) timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function* intervalIterator(ms, value, options = {}) {
  const { signal, ref = true } = options;
  if (signal && signal.aborted) throw abortError(signal);
  let pending = 0;
  let wake = null;
  const timer = setInterval(() => {
    pending++;
    if (wake) { wake(); wake = null; }
  }, ms);
  if (!ref) timer.unref();
  let aborted = false;
  const onAbort = () => { aborted = true; if (wake) { wake(); wake = null; } };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (aborted) throw abortError(signal);
      if (pending === 0) await new Promise((r) => { wake = r; });
      if (aborted) throw abortError(signal);
      pending--;
      yield value;
    }
  } finally {
    clear(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function install() {
  const patched = { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate };
  for (const [name, fn] of Object.entries(patched)) {
    globalThis[name] = fn;
    timers[name] = fn;
  }

  timersPromises.setTimeout = function (ms, value, options) {
    return promised((cb) => setTimeout(cb, ms), value, options);
  };
  timersPromises.setImmediate = function (value, options) {
    return promised((cb) => setImmediate(cb), value, options);
  };
  timersPromises.setInterval = intervalIterator;
  if (timersPromises.scheduler) {
    timersPromises.scheduler.wait = (ms, options) => timersPromises.setTimeout(ms, undefined, options);
    timersPromises.scheduler.yield = () => timersPromises.setImmediate();
  }

  AbortSignal.timeout = function timeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, ms);
    timer.unref();
    return controller.signal;
  };
}

module.exports = { install, create, clear, Timeout };
