'use strict';

// Pristine references, captured before any patch is applied.
// Everything inside deja must go through these, never through the globals,
// otherwise the recorder would record (and the replayer would replay) itself.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const crypto = require('node:crypto');
const timers = require('node:timers');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');

const listeningDescriptor = Object.getOwnPropertyDescriptor(net.Server.prototype, 'listening');

module.exports = Object.freeze({
  random: Math.random,
  Date: globalThis.Date,
  dateNow: Date.now,
  perfNow: performance.now.bind(performance),
  timeOrigin: performance.timeOrigin,
  hrtime: process.hrtime,
  hrtimeBigint: process.hrtime.bigint,

  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval,
  clearInterval: timers.clearInterval,
  setImmediate: timers.setImmediate,
  clearImmediate: timers.clearImmediate,

  randomBytes: crypto.randomBytes,
  randomUUID: crypto.randomUUID,
  randomInt: crypto.randomInt,
  randomFillSync: crypto.randomFillSync,
  getRandomValues: crypto.getRandomValues,

  Socket: net.Socket,
  socketConnect: net.Socket.prototype.connect,
  socketSetTimeout: net.Socket.prototype.setTimeout,
  socketDestroy: net.Socket.prototype._destroy,
  serverListen: net.Server.prototype.listen,
  serverAddress: net.Server.prototype.address,
  serverClose: net.Server.prototype.close,
  serverListeningGet: listeningDescriptor && listeningDescriptor.get,
  emit: EventEmitter.prototype.emit,
  tlsConnect: tls.connect,
  TLSSocket: tls.TLSSocket,
  TLSServer: tls.Server,

  dnsLookup: dns.lookup,
  dnsPromisesLookup: dns.promises.lookup,
  readFile: fs.readFile,
  readFilePromise: fs.promises.readFile,

  openSync: fs.openSync,
  writeSync: fs.writeSync,
  closeSync: fs.closeSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,

  hostname: os.hostname,
  nextTick: process.nextTick,
  AbortSignalTimeout: AbortSignal.timeout,
});
