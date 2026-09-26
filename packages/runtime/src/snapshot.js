'use strict';

// State snapshots at an arbitrary event, taken from *inside* the replaying
// process with an in-process inspector session (no DevTools needed).
//
//  - app-side events (Math.random, sock.write ...) happen with app frames on
//    the stack, so we pause right there and read those frames' scopes.
//  - deliveries (a timer fires, bytes arrive) have no app frames yet, so we
//    pause and single-step into the first statement of app code that runs as
//    a consequence of the event, then read its scopes.

const path = require('node:path');
const inspector = require('node:inspector');
const { fileURLToPath } = require('node:url');

const SCOPES = new Set(['local', 'closure', 'block', 'catch', 'module', 'script']);
const MAX_STEPS = 250000;

function post(session, method, params) {
  let result;
  let error;
  let done = false;
  session.post(method, params || {}, (e, r) => { error = e; result = r; done = true; });
  if (!done) throw new Error(`inspector ${method} did not answer synchronously`);
  if (error) throw new Error(error.message || String(error));
  return result;
}

function toFile(url) {
  if (url && url.startsWith('file://')) {
    try { return fileURLToPath(url); } catch {}
  }
  return url || '';
}

function classify(file, runtimeDir) {
  if (!file) return 'native';
  if (file.startsWith('node:')) return 'node';
  if (file.startsWith(runtimeDir)) return 'deja';
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return 'lib';
  return 'app';
}

function remote(v) {
  if (!v) return { type: 'undefined' };
  const out = { type: v.type };
  if (v.subtype) out.subtype = v.subtype;
  if ('value' in v) {
    out.value = typeof v.value === 'string' && v.value.length > 400 ? `${v.value.slice(0, 400)}…` : v.value;
  } else if (v.unserializableValue) {
    out.value = v.unserializableValue;
  }
  if (v.description !== undefined && v.type !== 'string') {
    out.desc = v.description.length > 300 ? `${v.description.slice(0, 300)}…` : v.description;
  }
  if (v.preview) {
    out.preview = {
      overflow: v.preview.overflow,
      props: (v.preview.properties || []).map((p) => ({ name: p.name, type: p.type, subtype: p.subtype, value: p.value })),
    };
    if (v.preview.entries) {
      out.preview.entries = v.preview.entries.slice(0, 10).map((e) => ({
        key: e.key && e.key.description,
        value: e.value && e.value.description,
      }));
    }
  }
  return out;
}

class Capture {
  constructor({ runtimeDir, cwd }) {
    this.runtimeDir = runtimeDir;
    this.cwd = cwd;
    this.scripts = new Map();
    this.session = new inspector.Session();
    this.session.connect();
    this.session.on('Debugger.scriptParsed', ({ params }) => this.scripts.set(params.scriptId, params.url));
    post(this.session, 'Debugger.enable');
  }

  frameInfo(f) {
    const file = toFile(f.url || this.scripts.get(f.location.scriptId));
    return {
      fn: f.functionName || '(anonymous)',
      file,
      rel: file && !file.startsWith('node:') ? path.relative(this.cwd, file) : file,
      line: f.location.lineNumber + 1,
      col: f.location.columnNumber + 1,
      kind: classify(file, this.runtimeDir),
    };
  }

  props(objectId, limit = 40) {
    const { result } = post(this.session, 'Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
    return result
      .filter((p) => p.value || p.get)
      .slice(0, limit)
      .map((p) => ({ name: p.name, ...(p.value ? remote(p.value) : { type: 'accessor' }) }));
  }

  collect(callFrames) {
    const frames = callFrames.slice(0, 40).map((f) => this.frameInfo(f));
    const hasApp = frames.some((f) => f.kind === 'app');
    let detailed = 0;
    frames.forEach((fr, idx) => {
      if (detailed >= 4) return;
      if (fr.kind !== 'app' && !(fr.kind === 'lib' && !hasApp)) return;
      const cf = callFrames[idx];
      fr.scopes = cf.scopeChain
        .filter((sc) => SCOPES.has(sc.type))
        .slice(0, 4)
        .map((sc) => ({ type: sc.type, name: sc.name, vars: this.props(sc.object.objectId) }));
      if (cf.this && cf.this.type === 'object' && cf.this.className !== 'global' && cf.this.className !== 'Object') {
        fr.self = remote(cf.this);
      }
      detailed++;
    });
    return frames;
  }

  close() {
    try { post(this.session, 'Debugger.disable'); } catch {}
    try { this.session.disconnect(); } catch {}
  }
}

function summarize(ev) {
  const out = { i: ev.i, k: ev.k, t: ev.t };
  if (ev.h !== undefined) out.h = ev.h;
  if (ev.c) out.c = ev.c;
  if (ev.s) out.s = ev.s;
  return out;
}

function captureHere(ev, opts) {
  const cap = new Capture(opts);
  let frames = null;
  cap.session.once('Debugger.paused', ({ params }) => {
    try { frames = cap.collect(params.callFrames); } finally { post(cap.session, 'Debugger.resume'); }
  });
  // eslint-disable-next-line no-debugger
  debugger;
  cap.close();
  return { event: summarize(ev), mode: 'at-call', frames: frames || [], pausedIn: frames && (frames.find((f) => f.kind === 'app') || frames[0]) };
}

// Arms a step-into that follows a delivery into the first app statement it
// causes. Returns a pending object the scheduler polls on its next turn.
function armStep(ev, handle, opts) {
  const cap = new Capture(opts);
  const pending = {
    done: false,
    expired: false,
    pumpReturned: false,
    steps: 0,
    frames: null,
    result() {
      cap.close();
      return {
        event: summarize(ev),
        mode: 'step-into',
        steps: this.steps,
        frames: this.frames || [],
        pausedIn: this.frames && this.frames[0],
        note: this.frames ? null : 'This event did not run any application code (it was absorbed by Node internals or a library).',
      };
    },
  };
  let first = true;
  cap.session.on('Debugger.paused', ({ params }) => {
    if (pending.done || pending.expired) return post(cap.session, 'Debugger.resume');
    const top = cap.frameInfo(params.callFrames[0]);
    if (first) {
      first = false;
      return post(cap.session, 'Debugger.stepInto');
    }
    pending.steps++;
    if (top.kind === 'app') {
      try { pending.frames = cap.collect(params.callFrames); } finally {
        pending.done = true;
        post(cap.session, 'Debugger.resume');
      }
      return undefined;
    }
    const backInScheduler = pending.pumpReturned && top.kind === 'deja' && top.fn === 'dejaPump';
    if (backInScheduler || pending.steps > MAX_STEPS) {
      pending.expired = true;
      return post(cap.session, 'Debugger.resume');
    }
    return post(cap.session, 'Debugger.stepInto');
  });
  // eslint-disable-next-line no-debugger
  debugger;
  return pending;
}

// For the crash event itself: pause at the throw — before the stack unwinds —
// by pausing on exceptions and matching the recorded error message.
function armThrow(ev, opts) {
  const cap = new Capture(opts);
  post(cap.session, 'Debugger.setPauseOnExceptions', { state: 'all' });
  const expected = String((ev.v && ev.v.message) || '');
  const pending = {
    done: false,
    expired: false,
    frames: null,
    result() {
      cap.close();
      return {
        event: summarize(ev),
        mode: 'at-throw',
        frames: this.frames || [],
        pausedIn: this.frames && (this.frames.find((f) => f.kind === 'app') || this.frames[0]),
        note: this.frames ? null : 'The replay never threw the recorded error.',
      };
    },
  };
  cap.session.on('Debugger.paused', ({ params }) => {
    try {
      const description = String((params.data && params.data.description) || '');
      if (!pending.frames && params.reason === 'exception' && expected && description.includes(expected)) {
        pending.frames = cap.collect(params.callFrames);
      }
    } finally {
      post(cap.session, 'Debugger.resume');
    }
  });
  return pending;
}

module.exports = { captureHere, armStep, armThrow };
