'use strict';

// The tape is the single ordered log of everything nondeterministic that
// happened to the process. There are three families of events:
//
//   values      Math.random(), Date.now(), crypto bytes ...    app pulls them
//   structure   timer.set, sock.connect, sock.write ...        app causes them
//   deliveries  timer fired, socket data arrived ...           world pushes them
//
// Recording appends to the tape. Replay walks a cursor along it: values and
// structure are consumed by the app itself (and verified), deliveries are
// performed by the scheduler, one per macrotask, in recorded order.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { AsyncLocalStorage } = require('node:async_hooks');
const O = require('./originals');
const { LogWriter, readLog } = require('./log');
const { serializeError } = require('./codec');

const RUNTIME_DIR = path.resolve(__dirname, '..') + path.sep;

const DELIVERIES = new Set([
  'timer', 'immediate',
  'conn.accept', 'srv.listening', 'srv.error',
  'sock.open', 'sock.data', 'sock.eof', 'sock.error', 'sock.hangup',
  'op.done', 'signal',
]);

const REDACT = /(SECRET|TOKEN|PASSW(OR)?D|PRIVATE|API_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

const als = new AsyncLocalStorage();

const S = {
  mode: 'off',
  seq: 0,
  nextHandle: 1,
  handles: new Map(),
  events: null,
  header: null,
  trailer: null,
  writer: null,
  file: null,
  t0: 0,
  cwd: process.cwd(),
  stacks: true,
  checkSites: true,
  until: null,
  snapshot: false,
  inspect: false,
  reportFile: null,
  quiet: false,
  requests: 0,
  report: null,
  done: false,
  internal: 0,
  pendingSnapshot: null,
  idleSince: null,
  progressSeq: -1,
};

const recording = () => S.mode === 'record';
const replaying = () => S.mode === 'replay';
const active = () => S.mode !== 'off' && !S.done && S.internal === 0;

function ctx() {
  const store = als.getStore();
  return store ? store.rid : 0;
}

// ---------------------------------------------------------------- call sites

// raw V8 file name -> { rel, skip, lib }, computed once per file
const fileInfo = new Map();

function infoOf(raw) {
  let info = fileInfo.get(raw);
  if (info) return info;
  let file = raw;
  if (raw.startsWith('file://')) {
    try { file = fileURLToPath(raw); } catch {}
  }
  info = {
    rel: path.relative(S.cwd, file),
    skip: raw.startsWith('node:') || raw.startsWith('wasm:') || file.startsWith(RUNTIME_DIR),
    lib: file.includes(`${path.sep}node_modules${path.sep}`),
  };
  fileInfo.set(raw, info);
  return info;
}

const structured = (_, callSites) => callSites;

function captureFrames(limit) {
  const prevPrepare = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = limit;
    Error.prepareStackTrace = structured;
    const holder = {};
    Error.captureStackTrace(holder, callsite);
    return holder.stack;
  } finally {
    Error.prepareStackTrace = prevPrepare;
    Error.stackTraceLimit = prevLimit;
  }
}

function siteFrom(frames, complete) {
  if (!Array.isArray(frames)) return null;
  let first = null;
  for (const f of frames) {
    const raw = f.getFileName();
    if (!raw) continue;
    const info = infoOf(raw);
    if (info.skip) continue;
    const fn = f.getFunctionName() || f.getMethodName();
    const site = `${fn ? fn + ' ' : ''}${info.rel}:${f.getLineNumber()}:${f.getColumnNumber()}`;
    if (!first) {
      first = { s: site };
      if (!info.lib) return first;
    } else if (!info.lib) {
      first.a = site;
      return first;
    }
  }
  return complete ? first : undefined;
}

// Capturing a stack costs roughly per frame, so look at the nearest frames
// first and only walk further when the app's own code isn't among them.
function callsite() {
  if (!S.stacks) return null;
  const near = siteFrom(captureFrames(7), false);
  return near !== undefined ? near : siteFrom(captureFrames(18), true);
}

// ------------------------------------------------------------------ recording

function emitRecord(k, h, v, c, site) {
  const ev = { i: S.seq++, k, t: Math.round((O.perfNow() - S.t0) * 1000) / 1000 };
  if (h !== undefined) ev.h = h;
  if (c) ev.c = c;
  if (v !== undefined) ev.v = v;
  if (site) {
    ev.s = site.s;
    if (site.a) ev.a = site.a;
  }
  S.writer.push(ev);
  if (S.trace) process._rawDebug(`rec #${ev.i} ${k}${h !== undefined ? ' h' + h : ''}${ev.s ? ' @ ' + ev.s : ''}`);
  return ev;
}

// ------------------------------------------------------------------- replay

function describe(ev) {
  if (!ev) return { k: '<end of recording>' };
  const out = { i: ev.i, k: ev.k };
  if (ev.h !== undefined) out.h = ev.h;
  if (ev.s) out.s = ev.s;
  if (ev.a) out.a = ev.a;
  if (ev.c) out.c = ev.c;
  return out;
}

function warn(type, ev, detail) {
  const r = S.report;
  r.warnings.count++;
  if (r.warnings.items.length < 50) r.warnings.items.push({ type, at: ev ? ev.i : S.seq, k: ev && ev.k, ...detail });
}

function take(kind, h) {
  const ev = S.events[S.seq];
  if (!ev || ev.k !== kind || (h !== undefined && ev.h !== undefined && ev.h !== h)) {
    diverge(`the app produced "${kind}" but the recording expected ${ev ? `"${ev.k}"` : 'nothing more'}`, ev, { k: kind, h });
  }
  S.seq++;
  S.report.counts[kind] = (S.report.counts[kind] || 0) + 1;
  if (S.checkSites && ev.s) {
    const site = callsite();
    if (site && site.s !== ev.s) warn('callsite', ev, { expected: ev.s, actual: site.s });
  }
  if (S.until === ev.i) checkpoint(ev, null);
  return ev;
}

// ---------------------------------------------------------------- public API

// A nondeterministic value the app reads synchronously.
function value(kind, produce) {
  if (!active()) return produce();
  if (S.mode === 'record') {
    const v = produce();
    emitRecord(kind, undefined, v, ctx(), callsite());
    return v;
  }
  return take(kind).v;
}

// Something the app did (structure / output). In replay it is verified.
function mark(kind, h, v, opts) {
  if (!active()) return null;
  const o = opts || {};
  if (S.mode === 'record') return emitRecord(kind, h, v, o.c !== undefined ? o.c : ctx(), o.site === false ? null : callsite());
  const ev = take(kind, h);
  if (o.compare) o.compare(ev.v, v, ev);
  return ev;
}

// The outside world did something to a handle (record mode only; the replay
// scheduler calls handle.deliver() directly with the recorded event).
function deliver(handle, kind, v) {
  if (S.done) return undefined;
  const ev = emitRecord(kind, handle.id, v, handle.ctx, null);
  return handle.deliver(ev);
}

function allocHandle() { return S.nextHandle++; }
function peekHandle() { return S.nextHandle; }
function register(h) { S.handles.set(h.id, h); }
function unregister(id) { S.handles.delete(id); }

function internal(fn) {
  S.internal++;
  try { return fn(); } finally { S.internal--; }
}

// ----------------------------------------------------------- checkpoints

function checkpoint(ev, handle) {
  if (S.snapshot) {
    const snap = require('./snapshot');
    if (DELIVERIES.has(ev.k)) {
      S.pendingSnapshot = snap.armStep(ev, handle, { runtimeDir: RUNTIME_DIR, cwd: S.cwd });
    } else {
      S.report.snapshot = snap.captureHere(ev, { runtimeDir: RUNTIME_DIR, cwd: S.cwd });
      finish('snapshot', 0);
    }
    return;
  }
  if (S.inspect) {
    process._rawDebug(`\n  déjà ⏸  paused at event #${ev.i} (${ev.k})` +
      (DELIVERIES.has(ev.k) ? ' — step into the next call to follow it into your code\n' : ' — step out to reach the code that caused it\n'));
    // eslint-disable-next-line no-debugger
    debugger;
  }
}

function finishSnapshot() {
  const pending = S.pendingSnapshot;
  S.pendingSnapshot = null;
  S.report.snapshot = pending.result();
  finish('snapshot', 0);
}

// ------------------------------------------------------------------ reports

function newReport() {
  return {
    status: null,
    file: S.file,
    totalEvents: S.events.length,
    replayed: 0,
    counts: {},
    recordedSpanMs: S.events.length ? S.events[S.events.length - 1].t : 0,
    wallMs: 0,
    outputs: { compared: 0, mismatched: 0 },
    warnings: { count: 0, items: [] },
    crash: null,
    divergence: null,
    snapshot: null,
    until: S.until,
    recordedCrash: null,
    trailer: S.trailer,
  };
}

function diverge(message, expected, actual) {
  if (S.done) return;
  const site = callsite();
  S.report.divergence = {
    at: S.seq,
    message,
    expected: describe(expected),
    actual: { ...actual, s: site && site.s, a: site && site.a },
  };
  finish('diverged', 3);
}

function finish(status, code) {
  if (S.done) return;
  S.report.status = status;
  S.done = true;
  process.exit(code);
}

function finalizeReport(exitCode) {
  const r = S.report;
  r.replayed = S.seq;
  r.wallMs = Math.round(O.perfNow() - S.replayStartedAt);
  if (S.pendingSnapshot) {
    // The process is exiting (often: the event we stepped into crashed it).
    r.snapshot = S.pendingSnapshot.result();
    S.pendingSnapshot = null;
    r.status = 'snapshot';
  }
  if (!r.status) {
    if (r.crash && r.crash.match) r.status = 'reproduced';
    else if (r.crash) r.status = 'diverged';
    else if (S.seq >= S.events.length) r.status = 'faithful';
    else r.status = 'incomplete';
  }
  if (r.status === 'faithful' && r.recordedCrash) r.status = 'reproduced';
  r.exitCode = exitCode;
  if (S.reportFile) {
    try { O.writeFileSync(S.reportFile, JSON.stringify(r, null, 1)); } catch {}
  }
  if (!S.quiet) printReport(r);
}

function printReport(r) {
  const tty = process.stderr.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const n = (x) => x.toLocaleString('en-US');
  const verdicts = {
    reproduced: c('1;32', 'REPRODUCED'),
    faithful: c('1;32', 'FAITHFUL'),
    diverged: c('1;31', 'DIVERGED'),
    incomplete: c('1;33', 'INCOMPLETE'),
    snapshot: c('1;36', 'SNAPSHOT'),
  };
  const lines = [''];
  lines.push(`  ${c('1', 'déjà')} ${c('2', '▸ replay')}  ${shortPath(r.file)}`);
  lines.push(`  ${c('2', 'events  ')} ${n(r.replayed)} / ${n(r.totalEvents)} replayed in ${(r.wallMs / 1000).toFixed(2)}s ${c('2', `(recorded span ${(r.recordedSpanMs / 1000).toFixed(2)}s)`)}`);
  lines.push(`  ${c('2', 'outputs ')} ${n(r.outputs.compared)} socket writes verified, ${r.outputs.mismatched ? c('31', n(r.outputs.mismatched) + ' mismatched') : '0 mismatched'}`);
  if (r.recordedCrash && r.status !== 'snapshot') {
    const ok = r.crash && r.crash.match;
    lines.push(`  ${c('2', 'crash   ')} ${ok ? c('32', '✔ reproduced') : c('31', '✘ not reproduced')} at #${r.recordedCrash.i} — ${r.recordedCrash.v.name}: ${r.recordedCrash.v.message}`);
  }
  if (r.divergence) {
    const d = r.divergence;
    lines.push(`  ${c('2', 'diverged')} ${c('31', `at #${d.at}`)} — ${d.message}`);
    if (d.expected && d.expected.s) lines.push(`  ${c('2', '  expected')} ${d.expected.k} at ${d.expected.a || d.expected.s}`);
    if (d.actual && d.actual.s) lines.push(`  ${c('2', '  actual  ')} ${d.actual.k} at ${d.actual.a || d.actual.s}`);
  }
  if (r.warnings.count) lines.push(`  ${c('2', 'warnings')} ${c('33', n(r.warnings.count))} ${c('2', `(first: ${r.warnings.items[0].type} at #${r.warnings.items[0].at})`)}`);
  lines.push(`  ${c('2', 'verdict ')} ${verdicts[r.status] || r.status}`);
  lines.push('');
  process._rawDebug(lines.join('\n'));
}

// ------------------------------------------------------------------ setup

function redactEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('DEJA_')) continue;
    out[k] = REDACT.test(k) ? '[redacted]' : v;
  }
  return out;
}

function gitRevision(dir) {
  try {
    let d = dir;
    while (d && d !== path.dirname(d)) {
      const gitDir = path.join(d, '.git');
      if (fs.existsSync(gitDir)) {
        const head = O.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref: ')) return head;
        const ref = head.slice(5);
        const refFile = path.join(gitDir, ref);
        return fs.existsSync(refFile) ? O.readFileSync(refFile, 'utf8').trim() : ref;
      }
      d = path.dirname(d);
    }
  } catch {}
  return null;
}

function stripPreload(execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i];
    if ((a === '--require' || a === '-r') && /register\.js$/.test(execArgv[i + 1] || '')) { i++; continue; }
    if (/^(--require|-r)=.*register\.js$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

function shortPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.length < file.length ? rel : file;
}

function initRecord(env) {
  S.mode = 'record';
  S.file = path.resolve(env.DEJA_FILE || `deja-${O.dateNow()}.deja`);
  S.stacks = env.DEJA_STACKS !== '0';
  S.trace = env.DEJA_TRACE === '1';
  S.t0 = O.perfNow();
  const header = {
    tool: 'deja',
    version: 1,
    createdAt: new O.Date(O.dateNow()).toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    hostname: O.hostname(),
    cwd: process.cwd(),
    entry: process.argv[1] ? path.resolve(process.argv[1]) : null,
    argv: process.argv.slice(2),
    execArgv: stripPreload(process.execArgv),
    env: redactEnv(process.env),
    timeOrigin: O.timeOrigin,
    stacks: S.stacks,
    git: gitRevision(process.cwd()),
    label: env.DEJA_LABEL || null,
  };
  S.header = header;
  S.writer = new LogWriter(S.file, header);

  const flusher = O.setInterval(() => { if (!S.writer.closed) S.writer.flush(); }, 400);
  flusher.unref();

  let crashed = false;
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    crashed = true;
    emitRecord('crash', undefined, { ...serializeError(err), origin }, ctx(), null);
    S.writer.flush();
  });

  const close = (extra) => {
    if (S.writer.closed) return;
    S.writer.close({
      endedAt: new O.Date(O.dateNow()).toISOString(),
      durationMs: Math.round(O.perfNow() - S.t0),
      events: S.seq,
      crashed,
      ...extra,
    });
    if (env.DEJA_ANNOUNCE !== '0') {
      process._rawDebug(`\n  déjà ● recorded ${S.seq.toLocaleString('en-US')} events → ${shortPath(S.file)}${crashed ? '  (process crashed — replay it!)' : ''}\n`);
    }
  };
  process.on('exit', (code) => close({ exit: { code } }));
  // Signal listeners are installed by patches/process.js, *after* it patches
  // process.emit: Node binds process.emit when the first one is added.
  S.closeRecording = close;
}

function initReplay(env) {
  S.mode = 'replay';
  S.file = path.resolve(env.DEJA_FILE);
  const log = readLog(S.file);
  S.header = log.header;
  S.events = log.events;
  S.trailer = log.trailer;
  S.stacks = log.header.stacks !== false;
  S.checkSites = S.stacks && env.DEJA_CHECK_SITES !== '0';
  S.until = env.DEJA_UNTIL !== undefined && env.DEJA_UNTIL !== '' ? Number(env.DEJA_UNTIL) : null;
  S.snapshot = env.DEJA_SNAPSHOT === '1';
  S.inspect = env.DEJA_INSPECT === '1';
  S.reportFile = env.DEJA_REPORT || null;
  S.quiet = env.DEJA_QUIET === '1';
  S.cwd = log.header.cwd || process.cwd();
  S.replayStartedAt = O.perfNow();
  S.report = newReport();
  S.report.recordedCrash = S.events.find((e) => e.k === 'crash') || null;
  if (S.snapshot && S.until !== null && S.events[S.until] && S.events[S.until].k === 'crash') {
    S.pendingSnapshot = require('./snapshot').armThrow(S.events[S.until], { runtimeDir: RUNTIME_DIR, cwd: S.cwd });
  }

  // Put the process back into the recorded environment.
  const recordedEnv = log.header.env || {};
  for (const k of Object.keys(process.env)) if (!(k in recordedEnv)) delete process.env[k];
  Object.assign(process.env, recordedEnv);
  try { Object.defineProperty(process, 'pid', { value: log.header.pid, configurable: true, writable: true, enumerable: true }); } catch {}

  process.on('uncaughtExceptionMonitor', (err, origin) => {
    if (S.done) return;
    const ev = S.events[S.seq];
    const actual = { ...serializeError(err), origin };
    if (!ev || ev.k !== 'crash') {
      S.report.crash = { match: false, actual };
      diverge(`the app crashed but the recording expected ${ev ? `"${ev.k}"` : 'nothing more'}`, ev, { k: 'crash', v: actual });
      return;
    }
    S.seq++;
    const match = ev.v.message === actual.message && ev.v.name === actual.name;
    S.report.crash = { match, at: ev.i, expected: ev.v, actual };
  });

  process.on('exit', (code) => finalizeReport(code));
}

module.exports = {
  S,
  als,
  DELIVERIES,
  RUNTIME_DIR,
  recording,
  replaying,
  active,
  ctx,
  callsite,
  value,
  mark,
  deliver,
  warn,
  diverge,
  finish,
  finishSnapshot,
  checkpoint,
  allocHandle,
  peekHandle,
  register,
  unregister,
  internal,
  initRecord,
  initReplay,
};
