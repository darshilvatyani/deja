import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { c, n, bytes, describe } from './format.js';

const require = createRequire(import.meta.url);
const { readLog } = require('@deja/runtime/log');
const launcher = require('@deja/runtime/launcher');

const VERDICT_OK = new Set(['reproduced', 'faithful']);

function needFile(file) {
  if (!file) throw new Error('missing recording path');
  if (!fs.existsSync(file)) throw new Error(`no such recording: ${file}`);
  return path.resolve(file);
}

// ------------------------------------------------------------------ record

export async function record(opts, command) {
  if (!command.length) throw new Error('usage: deja record [-o file.deja] -- node app.js [args]');
  const child = launcher.record(command, {
    output: opts.o || opts.output,
    label: opts.label,
    stacks: opts.stacks !== false,
  });
  const forward = (sig) => () => child.kill(sig);
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, forward(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);
  const { code, signal } = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  for (const [sig, h] of handlers) process.removeListener(sig, h);
  if (fs.existsSync(child.recordingFile)) {
    console.log(`  ${c.dim('next:')} deja replay ${path.relative(process.cwd(), child.recordingFile)}`);
  }
  return code === null ? (signal === 'SIGINT' ? 0 : 1) : code;
}

// ------------------------------------------------------------------ replay

export async function replay(opts, [file]) {
  const abs = needFile(file);
  const until = opts.until !== undefined ? Number(opts.until) : null;
  const res = await launcher.replay(abs, {
    until,
    inspect: !!opts.inspect,
    snapshot: !!opts.snapshot,
    checkSites: opts.sites !== false,
    stdio: opts.json ? 'pipe' : 'inherit',
    quiet: !!opts.json,
    timeoutMs: opts.inspect ? 24 * 3600e3 : 10 * 60e3,
  });
  const r = res.report;
  if (!r) {
    console.error(c.red('replay produced no report (the process was killed?)'));
    return 1;
  }
  if (opts.report) fs.writeFileSync(opts.report, JSON.stringify(r, null, 2));
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  if (r.snapshot && !opts.json) printSnapshot(r.snapshot);
  return VERDICT_OK.has(r.status) || r.status === 'snapshot' ? 0 : 1;
}

function formatVar(v) {
  if (v.type === 'string') return JSON.stringify(v.value);
  if (v.type === 'number' || v.type === 'boolean' || v.type === 'bigint') return String(v.value);
  if (v.type === 'undefined') return 'undefined';
  if (v.subtype === 'null') return 'null';
  if (v.type === 'function') return `ƒ ${(v.desc || '').split('\n')[0]}`;
  if (v.preview && v.preview.props) {
    const inner = v.preview.props.map((p) => (v.subtype === 'array' ? p.value : `${p.name}: ${p.type === 'string' ? JSON.stringify(p.value) : p.value}`));
    if (v.preview.overflow) inner.push('…');
    return v.subtype === 'array' ? `[${inner.join(', ')}]` : `${v.desc && v.desc !== 'Object' ? v.desc + ' ' : ''}{${inner.join(', ')}}`;
  }
  return (v.desc || v.type).split('\n')[0];
}

function printSnapshot(snap) {
  console.log(`\n  ${c.bold('snapshot')} at #${snap.event.i} ${c.cyan(snap.event.k)} ${c.dim(`(${snap.mode})`)}`);
  if (snap.note) console.log(`  ${c.dim(snap.note)}`);
  for (const f of snap.frames.slice(0, 12)) {
    const where = `${f.rel || f.file}:${f.line}:${f.col}`;
    const tag = f.kind === 'app' ? c.green('app ') : c.dim(f.kind.padEnd(4));
    console.log(`  ${tag} ${f.fn} ${c.dim(where)}`);
    for (const scope of f.scopes || []) {
      if (scope.type === 'module' || scope.type === 'script') continue;
      for (const v of scope.vars.slice(0, 12)) {
        console.log(`         ${c.dim(scope.type.padEnd(7))} ${v.name} = ${formatVar(v).slice(0, 100)}`);
      }
    }
  }
  console.log('');
}

// ------------------------------------------------------------------ verify

export async function verify(opts, [file]) {
  const abs = needFile(file);
  const runs = Number(opts.runs || 5);
  console.log(`\n  ${c.bold('déjà')} ${c.dim('▸ verify')}  replaying ${path.relative(process.cwd(), abs)} ${runs}× — every run must match\n`);
  const seen = [];
  for (let i = 1; i <= runs; i++) {
    const t = Date.now();
    const { report: r, stdout } = await launcher.replay(abs, { stdio: 'pipe' });
    const ok = r && VERDICT_OK.has(r.status);
    const fingerprint = r ? `${r.status}|${r.replayed}|${r.outputs.mismatched}|${r.crash ? r.crash.actual.message : ''}|${stdout}` : 'none';
    seen.push(fingerprint);
    const same = fingerprint === seen[0];
    console.log(`  run ${String(i).padStart(2)}  ${ok ? c.green('✔') : c.red('✘')} ${r ? r.status.padEnd(10) : 'no report '} ` +
      `${r ? `${n(r.replayed)}/${n(r.totalEvents)} events` : ''}  ${c.dim(`${Date.now() - t}ms`)}  ${same ? '' : c.red('differs from run 1')}`);
  }
  const allSame = seen.every((f) => f === seen[0]);
  const allOk = seen.every((f) => f.startsWith('reproduced') || f.startsWith('faithful'));
  console.log(`\n  ${allSame && allOk ? c.green(`deterministic: ${runs}/${runs} identical replays`) : c.red('NOT deterministic')}\n`);
  return allSame && allOk ? 0 : 1;
}

// ------------------------------------------------------------------ info

export async function info(opts, [file]) {
  const abs = needFile(file);
  const { header, events, trailer, truncated, size } = readLog(abs);
  const counts = {};
  for (const ev of events) counts[ev.k] = (counts[ev.k] || 0) + 1;
  const crash = events.find((e) => e.k === 'crash');
  const reqs = counts['http.req'] || 0;
  const span = events.length ? events[events.length - 1].t : 0;
  if (opts.json) {
    console.log(JSON.stringify({ header, trailer, counts, events: events.length, size }, null, 2));
    return 0;
  }
  const row = (k, v) => console.log(`  ${c.dim(k.padEnd(10))} ${v}`);
  console.log(`\n  ${c.bold('déjà')} ${c.dim('▸ recording')}  ${path.relative(process.cwd(), abs)}\n`);
  row('program', `node ${path.relative(process.cwd(), header.entry || '?')} ${(header.argv || []).join(' ')}`);
  row('recorded', `${header.createdAt}  on ${header.hostname} (pid ${header.pid})`);
  row('runtime', `${header.node} ${header.platform}/${header.arch}${header.git ? `  git ${header.git.slice(0, 10)}` : ''}`);
  row('span', `${(span / 1000).toFixed(2)}s  ·  ${n(events.length)} events  ·  ${bytes(size)} (${header.codec})`);
  row('requests', `${n(reqs)} http requests`);
  row('ended', trailer ? (trailer.exit && trailer.exit.signal ? `signal ${trailer.exit.signal}` : `exit code ${trailer.exit ? trailer.exit.code : '?'}`) : c.yellow('abruptly (no trailer — partial recording)'));
  if (truncated && trailer) row('', c.yellow('last block truncated'));
  if (crash) row('crash', c.red(`#${crash.i} ${crash.v.name}: ${crash.v.message}`));
  console.log(`\n  ${c.dim('events by kind')}`);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) console.log(`    ${k.padEnd(14)} ${c.dim(n(v).padStart(8))}`);
  console.log('');
  return 0;
}

// ------------------------------------------------------------------ cat

export async function cat(opts, [file]) {
  const abs = needFile(file);
  const { events } = readLog(abs);
  const from = opts.from !== undefined ? Number(opts.from) : 0;
  const to = opts.to !== undefined ? Number(opts.to) : Infinity;
  const kinds = opts.kind ? new Set(String(opts.kind).split(',')) : null;
  const req = opts.req !== undefined ? Number(opts.req) : null;
  for (const ev of events) {
    if (ev.i < from || ev.i > to) continue;
    if (kinds && !kinds.has(ev.k)) continue;
    if (req !== null && ev.c !== req) continue;
    if (opts.json) {
      console.log(JSON.stringify(ev, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v)));
      continue;
    }
    const kindColor = ev.k === 'crash' ? c.red : ['sock.data', 'conn.accept', 'sock.open', 'timer', 'immediate', 'op.done', 'sock.eof', 'sock.hangup', 'sock.error'].includes(ev.k) ? c.cyan : c.yellow;
    console.log(
      `${c.dim(`#${String(ev.i).padStart(6)}`)} ${c.dim(`${ev.t.toFixed(1).padStart(9)}ms`)} ` +
      `${kindColor(ev.k.padEnd(13))} ${c.dim(ev.h !== undefined ? `h${ev.h}`.padEnd(5) : '     ')} ` +
      `${ev.c ? c.magenta(`r${ev.c}`.padEnd(4)) : '    '} ${describe(ev)}${ev.s ? c.dim(`  ${ev.a || ev.s}`) : ''}`,
    );
  }
  return 0;
}

// ------------------------------------------------------------------ view

export async function view(opts, [file]) {
  const abs = needFile(file);
  const { startViewer } = await import('@deja/viewer');
  const port = Number(opts.port || 7077);
  const { url } = await startViewer({ file: abs, port });
  console.log(`\n  ${c.bold('déjà')} ${c.dim('▸ viewer')}  ${c.cyan(url)}   ${c.dim('(ctrl-c to stop)')}\n`);
  if (opts.open !== false && process.platform === 'darwin') {
    const { spawn } = await import('node:child_process');
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
  return new Promise(() => {});
}
