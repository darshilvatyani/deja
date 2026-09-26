'use strict';

// Networking is intercepted at the socket layer, which makes one mechanism
// cover everything built on net/tls: http/https clients, fetch (undici), the
// http server, database drivers, Redis clients...
//
// The app never touches a real socket. It always gets a *fake* net.Socket
// without a native handle. When recording, the fake is bridged to a real
// socket that deja owns: real events are logged as deliveries and pushed into
// the fake. When replaying, the scheduler pushes the recorded deliveries into
// the fake and no network is used at all. Because the app sees the very same
// object type in both modes, stream internals behave identically.

const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const { AsyncResource } = require('node:async_hooks');
const O = require('../originals');
const tape = require('../tape');
const timers = require('./timers');
const { serializeError, reviveError } = require('../codec');

const kHandle = Symbol('deja.socket');
const kInternal = Symbol('deja.internal');
const kPendingTimeout = Symbol('deja.pendingTimeout');
const kServer = Symbol('deja.server');

const peerOf = (s) => ({ address: s.remoteAddress, family: s.remoteFamily, port: s.remotePort });

function toBuffer(chunk, encoding) {
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
  return Buffer.from(chunk); // copy: the app may reuse its buffer after write()
}

// ------------------------------------------------------------ output checks

const maskDate = (b) => b.toString('latin1').replace(/\r\ndate: [^\r\n]*/gi, '\r\ndate: *');

function sameBytes(expected, actual) {
  if (!Buffer.isBuffer(expected)) return false;
  if (expected.equals(actual)) return true;
  // Node core stamps the HTTP Date header from its own (unpatched) clock.
  return expected.length === actual.length && maskDate(expected) === maskDate(actual);
}

const preview = (b) => (Buffer.isBuffer(b) ? b.subarray(0, 240).toString('latin1') : String(b));

function compareOutput(expected, actual, ev) {
  const r = tape.S.report;
  r.outputs.compared++;
  if (sameBytes(expected, actual)) return;
  r.outputs.mismatched++;
  tape.warn('output', ev, { expected: preview(expected), actual: preview(actual) });
}

function compareMeta(expected, actual, ev) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) tape.warn('meta', ev, { expected, actual });
}

// ------------------------------------------------------------ socket handle

class SocketHandle {
  constructor(id, sock, { client, secure }) {
    this.id = id;
    this.sock = sock;
    this.client = client;
    this.secure = secure;
    this.ctx = tape.ctx();
    this.resource = new AsyncResource('DejaSocket');
    this.real = null;
    this.idle = null;
    this.local = {};
    this.tornDown = false;
  }

  deliver(ev) {
    return this.resource.runInAsyncScope(this._deliver, this, ev);
  }

  _deliver(ev) {
    const s = this.sock;
    switch (ev.k) {
      case 'sock.open': {
        const v = ev.v || {};
        s.connecting = false;
        s._peername = v.peer;
        this.local = v.local || {};
        if (this.secure) this.applyTls(v.tls || {});
        this.touch();
        s.emit('connect');
        if (this.secure) s.emit('secureConnect');
        s.emit('ready');
        return;
      }
      case 'sock.data':
        this.touch();
        s.push(Buffer.from(ev.v));
        return;
      case 'sock.eof':
        this.touch();
        s.push(null);
        return;
      case 'sock.error':
        s.destroy(reviveError(ev.v));
        return;
      case 'sock.hangup':
        s.destroy();
        return;
      default:
        throw new Error(`deja: unknown socket delivery ${ev.k}`);
    }
  }

  touch() {
    if (this.idle) this.idle.refresh();
  }

  setIdle(ms, callback) {
    const s = this.sock;
    const n = Number(ms);
    if (typeof callback === 'function') {
      if (n === 0) s.removeListener('timeout', callback);
      else s.once('timeout', callback);
    }
    if (this.idle) {
      timers.clear(this.idle);
      this.idle = null;
    }
    if (n > 0 && Number.isFinite(n)) {
      this.idle = timers.create('timeout', () => { if (!s.destroyed) s.emit('timeout'); }, n, []);
      this.idle.unref();
    }
  }

  applyTls(info) {
    const s = this.sock;
    s.encrypted = true;
    s.authorized = !!info.authorized;
    s.authorizationError = info.authorizationError || null;
    s.alpnProtocol = info.alpnProtocol === undefined ? false : info.alpnProtocol;
    s.servername = info.servername || s.servername;
    s.getPeerCertificate = () => info.cert || {};
    s.getProtocol = () => info.protocol || null;
    s.getCipher = () => info.cipher || null;
    s.getSession = () => undefined;
    s.getTLSTicket = () => undefined;
    s.isSessionReused = () => false;
    s.getEphemeralKeyInfo = () => ({});
    s.getFinished = () => undefined;
    s.getPeerFinished = () => undefined;
    s.setServername = () => {};
  }

  teardown(err) {
    if (this.tornDown) return;
    this.tornDown = true;
    tape.mark('sock.destroy', this.id, err ? serializeError(err) : undefined, { site: false });
    if (this.idle) {
      timers.clear(this.idle);
      this.idle = null;
    }
    tape.unregister(this.id);
    if (this.real) this.real.destroy();
  }

  // Record mode: attach the real socket and turn its events into deliveries.
  wireReal(real) {
    this.real = real;
    real[kInternal] = true;
    const s = this.sock;
    if (this.client) {
      real.once(this.secure ? 'secureConnect' : 'connect', () => {
        if (s.destroyed) return;
        tape.deliver(this, 'sock.open', {
          peer: peerOf(real),
          local: real.address(),
          tls: this.secure ? tlsInfoOf(real) : undefined,
        });
      });
    }
    real.on('data', (chunk) => { if (!s.destroyed) tape.deliver(this, 'sock.data', chunk); });
    real.on('end', () => { if (!s.destroyed && !s._readableState.ended) tape.deliver(this, 'sock.eof'); });
    real.on('error', (err) => { if (!s.destroyed) tape.deliver(this, 'sock.error', serializeError(err)); });
    real.on('close', () => { if (!s.destroyed) tape.deliver(this, 'sock.hangup'); });
  }
}

function tlsInfoOf(real) {
  let cert = null;
  try {
    const c = real.getPeerCertificate();
    if (c && Object.keys(c).length) {
      cert = {
        subject: { ...c.subject },
        issuer: { ...c.issuer },
        subjectaltname: c.subjectaltname,
        valid_from: c.valid_from,
        valid_to: c.valid_to,
        fingerprint256: c.fingerprint256,
        serialNumber: c.serialNumber,
      };
    }
  } catch {}
  return {
    authorized: real.authorized,
    authorizationError: real.authorizationError ? String(real.authorizationError) : null,
    alpnProtocol: real.alpnProtocol,
    servername: real.servername,
    protocol: real.getProtocol && real.getProtocol(),
    cipher: real.getCipher && real.getCipher(),
    cert,
  };
}

function installFake(sock, h) {
  sock[kHandle] = h;
  sock._read = function _read() {};
  sock._write = function _write(chunk, encoding, cb) {
    writeOut(h, toBuffer(chunk, encoding));
    cb();
  };
  sock._writev = function _writev(chunks, cb) {
    writeOut(h, Buffer.concat(chunks.map((c) => toBuffer(c.chunk, c.encoding))));
    cb();
  };
  sock._final = function _final(cb) {
    tape.mark('sock.end', h.id, undefined, { site: false });
    if (h.real) h.real.end();
    cb();
  };
  sock._destroy = function _destroy(err, cb) {
    h.teardown(err);
    O.socketDestroy.call(this, err, cb);
  };
  sock._getsockname = function _getsockname() { return h.local || {}; };
  sock.setTimeout = function setTimeout(ms, cb) { h.setIdle(ms, cb); return this; };
  sock.setNoDelay = function setNoDelay(v) { if (h.real) h.real.setNoDelay(v); return this; };
  sock.setKeepAlive = function setKeepAlive(e, d) { if (h.real) h.real.setKeepAlive(e, d); return this; };
  sock.ref = function ref() { if (h.real) h.real.ref(); return this; };
  sock.unref = function unref() { if (h.real) h.real.unref(); return this; };
  if (h.secure) h.applyTls({});
}

function writeOut(h, buf) {
  h.touch();
  tape.mark('sock.write', h.id, buf, { compare: compareOutput });
  if (h.real) h.real.write(buf);
}

// ------------------------------------------------------------- client side

function realOptions(options) {
  const out = { ...options };
  delete out.timeout;
  delete out.signal;
  delete out.onread;
  delete out.socket;
  // Our own dns.lookup patch must not run for deja's real sockets.
  out.lookup = options.lookup && options.lookup !== dns.lookup ? options.lookup : O.dnsLookup;
  return out;
}

function describeTarget(options, secure) {
  const d = {};
  if (options.path) d.path = String(options.path);
  else {
    d.host = options.host || 'localhost';
    d.port = options.port === undefined ? undefined : Number(options.port);
  }
  if (secure) {
    d.tls = true;
    if (options.servername) d.servername = options.servername;
  }
  return d;
}

function connectFake(sock, options, cb, secure) {
  const id = tape.allocHandle();
  const h = new SocketHandle(id, sock, { client: true, secure });
  installFake(sock, h);
  sock.connecting = true;
  tape.mark('sock.connect', id, describeTarget(options, secure));
  tape.register(h);
  if (typeof cb === 'function') sock.once(secure ? 'secureConnect' : 'connect', cb);

  const pending = sock[kPendingTimeout];
  if (pending) {
    sock[kPendingTimeout] = null;
    h.setIdle(pending[0], pending[1]);
  }
  const signal = options.signal;
  if (signal) {
    const onAbort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      err.cause = signal.reason;
      sock.destroy(err);
    };
    if (signal.aborted) process.nextTick(onAbort);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  if (tape.recording()) {
    tape.internal(() => {
      let real;
      if (secure) {
        real = O.tlsConnect(realOptions(options));
      } else {
        real = new O.Socket({ allowHalfOpen: options.allowHalfOpen });
        real[kInternal] = true;
        O.socketConnect.call(real, realOptions(options));
      }
      h.wireReal(real);
    });
  }
  return sock;
}

function patchedConnect(...args) {
  if (this[kInternal] || this instanceof O.TLSSocket || !tape.active()) {
    return O.socketConnect.apply(this, args);
  }
  const normalized = args.length === 1 && Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  return connectFake(this, normalized[0], normalized[1], false);
}

function patchedSetTimeout(ms, cb) {
  // net.connect() calls setTimeout() *before* connect(); remember it until the
  // socket becomes a fake so the idle timer can be virtualised as well.
  if (!this._handle && !this[kHandle] && !this[kInternal] && !(this instanceof O.TLSSocket) && tape.active()) {
    this[kPendingTimeout] = [ms, cb];
    return this;
  }
  return O.socketSetTimeout.call(this, ms, cb);
}

function normalizeTlsArgs(listArgs) {
  const args = net._normalizeArgs(listArgs);
  const options = args[0];
  if (listArgs[1] !== null && typeof listArgs[1] === 'object') Object.assign(options, listArgs[1]);
  else if (listArgs[2] !== null && typeof listArgs[2] === 'object') Object.assign(options, listArgs[2]);
  return [options, args[1]];
}

let warnedTlsSocket = false;

function patchedTlsConnect(...args) {
  if (!tape.active()) return O.tlsConnect.apply(this, args);
  const [options, cb] = normalizeTlsArgs(args);
  if (options.socket) {
    if (!warnedTlsSocket) {
      warnedTlsSocket = true;
      process._rawDebug('deja: tls.connect({ socket }) is not recorded (TLS upgrade of an existing socket)');
    }
    return O.tlsConnect.apply(this, args);
  }
  const sock = new O.Socket({ allowHalfOpen: options.allowHalfOpen });
  sock.servername = options.servername || (options.host && !net.isIP(options.host) ? options.host : undefined);
  connectFake(sock, options, cb, true);
  if (options.timeout) sock.setTimeout(options.timeout);
  return sock;
}

// ------------------------------------------------------------- server side

class ServerHandle {
  constructor(id, server) {
    this.id = id;
    this.server = server;
    this.ctx = tape.ctx();
    this.resource = new AsyncResource('DejaServer');
    this.awaitListening = false;
    this.listening = false;
    this.pendingReal = null;
  }

  deliver(ev) {
    return this.resource.runInAsyncScope(this._deliver, this, ev);
  }

  _deliver(ev) {
    const srv = this.server;
    if (ev.k === 'srv.listening') {
      this.listening = true;
      if (tape.replaying()) srv._handle = listenHandleStandIn();
      return O.emit.call(srv, 'listening');
    }
    if (ev.k === 'srv.error') {
      return O.emit.call(srv, 'error', reviveError(ev.v));
    }
    // conn.accept
    const v = ev.v || {};
    const fake = new O.Socket({ allowHalfOpen: srv.allowHalfOpen });
    const id = tape.allocHandle();
    if (v.sock !== undefined && v.sock !== id) tape.warn('handle-id', ev, { expected: v.sock, actual: id });
    const h = new SocketHandle(id, fake, { client: false, secure: false });
    installFake(fake, h);
    fake.connecting = false;
    fake._peername = v.peer;
    h.local = v.local || {};
    fake.server = srv;
    fake._server = srv;
    srv._connections++;
    tape.register(h);
    if (this.pendingReal) {
      const real = this.pendingReal;
      this.pendingReal = null;
      h.wireReal(real);
    }
    return O.emit.call(srv, 'connection', fake);
  }

  // Record mode: a real connection arrived on the listening handle.
  accept(real) {
    real[kInternal] = true;
    real._server = null; // the fake is what counts as the server's connection
    this.server._connections--;
    this.pendingReal = real;
    tape.deliver(this, 'conn.accept', { sock: tape.peekHandle(), peer: peerOf(real), local: real.address() });
    return true;
  }
}

// Replay: a listening server needs *some* _handle, because net.Server uses
// it as its "still open" flag (e.g. _emitCloseIfDrained() would otherwise
// emit 'close' every time the last connection goes away).
function listenHandleStandIn() {
  return {
    deja: true,
    close() {},
    ref() {},
    unref() {},
    getsockname() { return 0; },
  };
}

function describeListen(args) {
  const a = args[0];
  if (a !== null && typeof a === 'object') return { port: a.port, host: a.host, path: a.path };
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: a };
  return { port: a === undefined ? 0 : Number(a), host: typeof args[1] === 'string' ? args[1] : undefined };
}

function patchedListen(...args) {
  if (!tape.active() || this instanceof O.TLSServer) return O.serverListen.apply(this, args);
  const id = tape.allocHandle();
  const h = new ServerHandle(id, this);
  this[kServer] = h;
  tape.register(h);
  if (tape.recording()) {
    tape.internal(() => O.serverListen.apply(this, args));
    const sync = !!this._handle;
    h.awaitListening = !sync;
    h.listening = sync;
    tape.mark('srv.listen', id, { sync, ...describeListen(args), bound: sync ? O.serverAddress.call(this) : null });
  } else {
    const ev = tape.mark('srv.listen', id, undefined);
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (cb) this.once('listening', cb);
    if (ev && ev.v && ev.v.sync) {
      h.listening = true;
      this._handle = listenHandleStandIn();
      process.nextTick(() => { if (h.listening) O.emit.call(this, 'listening'); });
    } else {
      h.awaitListening = true;
    }
  }
  return this;
}

function patchedAddress() {
  if (!this[kServer] || !tape.active()) return O.serverAddress.call(this);
  return tape.value('srv.addr', () => O.serverAddress.call(this));
}

function patchedClose(cb) {
  const h = this[kServer];
  if (!h || !tape.active()) return O.serverClose.call(this, cb);
  tape.mark('srv.close', h.id, undefined);
  if (typeof cb === 'function') this.once('close', cb);
  h.listening = false;
  h.awaitListening = false;
  tape.unregister(h.id);
  if (tape.recording()) tape.internal(() => O.serverClose.call(this));
  else O.serverClose.call(this);
  return this;
}

function onRequest(server, req, res) {
  const rid = ++tape.S.requests;
  const sh = req.socket && req.socket[kHandle];
  const sid = sh ? sh.id : undefined;
  tape.mark('http.req', sid, { rid, method: req.method, url: req.url }, { c: rid, site: false, compare: compareMeta });
  res.once('close', () => {
    tape.mark('http.res', sid, { rid, status: res.statusCode, done: res.writableFinished }, { c: rid, site: false, compare: compareMeta });
  });
  return tape.als.run({ rid }, () => O.emit.call(server, 'request', req, res));
}

function patchedEmit(event, ...args) {
  const h = this[kServer];
  if (h && tape.recording() && !tape.S.done) {
    if (event === 'connection') {
      const s = args[0];
      if (s instanceof O.Socket && !s[kHandle] && s._handle) return h.accept(s);
    } else if (event === 'listening' && h.awaitListening) {
      h.awaitListening = false;
      tape.deliver(h, 'srv.listening');
      return true;
    } else if (event === 'error' && h.awaitListening) {
      h.awaitListening = false;
      tape.deliver(h, 'srv.error', serializeError(args[0]));
      return true;
    }
  }
  if (event === 'request' && args.length >= 2 && tape.active() && !(this instanceof O.TLSServer)) {
    return onRequest(this, args[0], args[1]);
  }
  return O.emit.call(this, event, ...args);
}

// http.Server tracks connections in a native std::set ordered by pointer, so
// closeAllConnections()/closeIdleConnections() destroy sockets in an order
// that changes from process to process. Sort them by deja handle instead.
const handleIdOf = (parser) => {
  const h = parser && parser.socket && parser.socket[kHandle];
  return h ? h.id : Number.MAX_SAFE_INTEGER;
};
let connectionsOrdered = false;

function orderConnections(server) {
  if (connectionsOrdered) return;
  const sym = Object.getOwnPropertySymbols(server).find((x) => x.description === 'http.server.connections');
  const list = sym && server[sym];
  if (!list) return;
  const proto = Object.getPrototypeOf(list);
  for (const name of ['all', 'idle', 'active', 'expired']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function sortedConnections(...args) {
      const result = original.apply(this, args);
      return Array.isArray(result) ? result.sort((a, b) => handleIdOf(a) - handleIdOf(b)) : result;
    };
  }
  connectionsOrdered = true;
}

function patchHttpServer() {
  const http = require('node:http');
  for (const name of ['closeAllConnections', 'closeIdleConnections']) {
    const original = http.Server.prototype[name];
    if (typeof original !== 'function') continue;
    http.Server.prototype[name] = function (...args) {
      orderConnections(this);
      return original.apply(this, args);
    };
  }
}

function install() {
  patchHttpServer();
  net.Socket.prototype.connect = patchedConnect;
  net.Socket.prototype.setTimeout = patchedSetTimeout;
  tls.connect = patchedTlsConnect;
  net.Server.prototype.listen = patchedListen;
  net.Server.prototype.address = patchedAddress;
  net.Server.prototype.close = patchedClose;
  net.Server.prototype.emit = patchedEmit;
  Object.defineProperty(net.Server.prototype, 'listening', {
    configurable: true,
    enumerable: false,
    get() {
      const h = this[kServer];
      if (h && tape.replaying()) return h.listening;
      return O.serverListeningGet ? O.serverListeningGet.call(this) : false;
    },
  });
}

module.exports = { install, kHandle };
