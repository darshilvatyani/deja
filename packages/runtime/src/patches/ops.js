'use strict';

// Callback/promise APIs whose completion time is decided by the OS or the
// libuv threadpool. Each call is an "op": op.start is structural, op.done is a
// delivery carrying the result, so a replay neither needs the network (DNS)
// nor the files that were read during the recording.

const fs = require('node:fs');
const dns = require('node:dns');
const { AsyncResource } = require('node:async_hooks');
const O = require('../originals');
const tape = require('../tape');
const { serializeError, reviveError } = require('../codec');

const cloneBuffers = (list) => (Array.isArray(list) ? list.map((x) => (Buffer.isBuffer(x) ? Buffer.from(x) : x)) : list);

class OpHandle {
  constructor(id, name, finish) {
    this.id = id;
    this.name = name;
    this.finish = finish;
    this.ctx = tape.ctx();
    this.resource = new AsyncResource('DejaOp');
  }

  deliver(ev) {
    tape.unregister(this.id);
    const v = ev.v || {};
    return this.resource.runInAsyncScope(this.finish, null, reviveError(v.err), cloneBuffers(v.res));
  }
}

function asyncOp(name, args, start, finish) {
  const id = tape.allocHandle();
  const h = new OpHandle(id, name, finish);
  tape.mark('op.start', id, { op: name, ...args });
  tape.register(h);
  if (tape.recording()) {
    tape.internal(() => start((err, res) => tape.deliver(h, 'op.done', { err: serializeError(err), res })));
  }
}

const isPathLike = (p) => typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL;
const encodingOf = (o) => (typeof o === 'string' ? o : o && o.encoding) || undefined;

function install() {
  dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!tape.active() || typeof callback !== 'function') return O.dnsLookup.call(this, hostname, options, callback);
    const o = typeof options === 'number' ? { family: options } : options || {};
    asyncOp('dns.lookup', { hostname, family: o.family, all: o.all || undefined },
      (done) => O.dnsLookup(hostname, options, (err, ...rest) => done(err, rest)),
      (err, rest) => callback(err, ...(rest || [])));
    return {};
  };

  dns.promises.lookup = function lookup(hostname, options) {
    if (!tape.active()) return O.dnsPromisesLookup(hostname, options);
    const o = typeof options === 'number' ? { family: options } : options || {};
    return new Promise((resolve, reject) => asyncOp('dns.lookup', { hostname, family: o.family, all: o.all || undefined },
      (done) => O.dnsPromisesLookup(hostname, options).then((r) => done(null, [r]), (e) => done(e)),
      (err, res) => (err ? reject(err) : resolve(res[0]))));
  };

  fs.readFile = function readFile(file, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (!tape.active() || typeof callback !== 'function' || !isPathLike(file)) {
      return O.readFile.call(this, file, options, callback);
    }
    asyncOp('fs.readFile', { path: String(file), encoding: encodingOf(options) },
      (done) => O.readFile(file, options, (err, data) => done(err, [data])),
      (err, res) => callback(err, res ? res[0] : undefined));
  };

  fs.promises.readFile = function readFile(file, options) {
    if (!tape.active() || !isPathLike(file)) return O.readFilePromise(file, options);
    return new Promise((resolve, reject) => asyncOp('fs.readFile', { path: String(file), encoding: encodingOf(options) },
      (done) => O.readFilePromise(file, options).then((d) => done(null, [d]), (e) => done(e)),
      (err, res) => (err ? reject(err) : resolve(res[0]))));
  };
}

module.exports = { install, asyncOp };
