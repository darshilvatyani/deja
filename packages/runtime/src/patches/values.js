'use strict';

// Synchronous sources of nondeterminism: randomness, clocks, crypto entropy.
// Each one becomes a "value" event: recorded when recording, returned from
// the tape when replaying.

const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const O = require('../originals');
const tape = require('../tape');

function patchMath() {
  Math.random = function random() {
    return tape.value('random', O.random);
  };
}

function patchDate() {
  const OriginalDate = O.Date;
  const now = () => tape.value('now', O.dateNow);

  // A function (not a class) so that `Date()` without `new` keeps working.
  function Date(...args) {
    if (!new.target) return new OriginalDate(now()).toString();
    return args.length === 0
      ? Reflect.construct(OriginalDate, [now()], new.target)
      : Reflect.construct(OriginalDate, args, new.target);
  }
  Object.defineProperty(Date, 'length', { value: 7 });
  Date.prototype = OriginalDate.prototype;
  Date.now = function now_() { return now(); };
  Object.defineProperty(Date.now, 'name', { value: 'now' });
  Date.parse = OriginalDate.parse;
  Date.UTC = OriginalDate.UTC;
  Object.defineProperty(OriginalDate.prototype, 'constructor', {
    value: Date, writable: true, configurable: true, enumerable: false,
  });
  globalThis.Date = Date;
}

function patchClocks() {
  performance.now = function now() {
    return tape.value('perf', O.perfNow);
  };
  if (tape.replaying() && tape.S.header.timeOrigin) {
    const origin = tape.S.header.timeOrigin;
    Object.defineProperty(performance, 'timeOrigin', { get: () => origin, configurable: true });
  }

  const hrtime = function hrtime(previous) {
    return tape.value('hrtime', () => O.hrtime(previous));
  };
  hrtime.bigint = function bigint() {
    return tape.value('hrtime.big', O.hrtimeBigint);
  };
  process.hrtime = hrtime;
}

function asBytes(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function patchCrypto() {
  crypto.randomBytes = function randomBytes(size, callback) {
    const bytes = tape.value('crypto.bytes', () => O.randomBytes(size));
    const buf = Buffer.from(bytes);
    if (typeof callback === 'function') {
      // Normalised: the threadpool round-trip becomes a deterministic tick.
      process.nextTick(callback, null, buf);
      return undefined;
    }
    return buf;
  };
  crypto.pseudoRandomBytes = crypto.randomBytes;

  crypto.randomUUID = function randomUUID(options) {
    return tape.value('crypto.uuid', () => O.randomUUID(options));
  };

  crypto.randomInt = function randomInt(min, max, callback) {
    if (typeof max === 'function') { callback = max; max = min; min = 0; }
    if (max === undefined) { max = min; min = 0; }
    const n = tape.value('crypto.int', () => O.randomInt(min, max));
    if (typeof callback === 'function') {
      process.nextTick(callback, null, n);
      return undefined;
    }
    return n;
  };

  const fill = (view, offset = 0, size) => {
    const bytes = asBytes(view);
    const end = size === undefined ? bytes.length : offset + size;
    const random = tape.value('crypto.fill', () => O.randomBytes(Math.max(0, end - offset)));
    bytes.set(random, offset);
    return view;
  };

  crypto.randomFillSync = function randomFillSync(buf, offset, size) {
    if (!ArrayBuffer.isView(buf)) return O.randomFillSync(buf, offset, size);
    return fill(buf, offset, size);
  };

  crypto.randomFill = function randomFill(buf, offset, size, callback) {
    if (typeof offset === 'function') { callback = offset; offset = 0; size = undefined; }
    else if (typeof size === 'function') { callback = size; size = undefined; }
    fill(buf, offset, size);
    process.nextTick(callback, null, buf);
  };

  const getRandomValues = function getRandomValues(array) {
    if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array || array.byteLength > 65536) {
      return O.getRandomValues.call(crypto.webcrypto, array); // let Node throw the proper error
    }
    return fill(array);
  };
  // node:crypto's getRandomValues is a non-configurable getter that forwards
  // to globalThis.crypto at call time, so patching the web instance covers it.

  const web = globalThis.crypto;
  if (web) {
    web.getRandomValues = getRandomValues;
    web.randomUUID = function randomUUID() {
      return tape.value('crypto.uuid', () => O.randomUUID());
    };
  }
}

function patchHost() {
  if (!tape.replaying()) return;
  const name = tape.S.header.hostname;
  os.hostname = function hostname() { return name; };
}

function install() {
  patchMath();
  patchDate();
  patchClocks();
  patchCrypto();
  patchHost();
}

module.exports = { install };
