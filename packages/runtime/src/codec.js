'use strict';

// Value encoding for events. JSON with a few tagged types:
//   {"$b": base64}   Buffer / Uint8Array
//   {"$n": "123"}    BigInt
//   {"$u": 1}        undefined inside arrays (JSON would turn it into null)
//   errors are serialized explicitly with serializeError()

function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Uint8Array) {
    return { $b: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
  }
  if (typeof value === 'bigint') return { $n: value.toString() };
  if (value === undefined && Array.isArray(this)) return { $u: 1 };
  return value;
}

function reviver(key, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.$b === 'string') return Buffer.from(value.$b, 'base64');
    if (typeof value.$n === 'string') return BigInt(value.$n);
    if (value.$u === 1) return undefined;
  }
  return value;
}

const encode = (value) => JSON.stringify(value, replacer);
const decode = (text) => JSON.parse(text, reviver);

const ERROR_FIELDS = ['code', 'errno', 'syscall', 'address', 'port', 'path', 'hostname', 'status', 'type'];

function serializeError(err) {
  if (err === null || err === undefined) return null;
  if (!(err instanceof Error)) return { name: 'NonError', message: String(err), thrown: typeof err };
  const out = { name: err.name, message: err.message, stack: err.stack };
  for (const f of ERROR_FIELDS) if (err[f] !== undefined) out[f] = err[f];
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);
  return out;
}

function reviveError(data) {
  if (!data) return null;
  const err = new Error(data.message);
  Object.defineProperty(err, 'name', { value: data.name, writable: true, configurable: true, enumerable: false });
  for (const f of ERROR_FIELDS) if (data[f] !== undefined) err[f] = data[f];
  if (data.cause) err.cause = reviveError(data.cause);
  if (data.stack) err.stack = data.stack;
  return err;
}

module.exports = { encode, decode, replacer, reviver, serializeError, reviveError };
