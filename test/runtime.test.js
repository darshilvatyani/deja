import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixtures, tmp, record, replay, readLog } from './helpers.js';

const require = createRequire(import.meta.url);
const { encode, decode, serializeError, reviveError } = require('@deja/runtime/codec');
const { LogWriter } = require('@deja/runtime/log');

const fixture = (name) => path.join(fixtures, name);

test('codec round-trips buffers, bigints, holes and errors', () => {
  const value = { b: Buffer.from([0, 1, 255]), n: 12345678901234567890n, arr: [1, undefined, 'x'], s: 'plain' };
  const back = decode(encode(value));
  assert.deepEqual(back.b, value.b);
  assert.equal(back.n, value.n);
  assert.equal(back.arr.length, 3);
  assert.equal(back.arr[1], undefined);
  const err = Object.assign(new Error('boom'), { code: 'ECONNRESET', errno: -54, syscall: 'read' });
  const revived = reviveError(serializeError(err));
  assert.equal(revived.message, 'boom');
  assert.equal(revived.code, 'ECONNRESET');
  assert.equal(revived.syscall, 'read');
});

test('log survives a crash mid-write (truncated tail is dropped, not fatal)', () => {
  const file = path.join(tmp, 'truncated.deja');
  const w = new LogWriter(file, { entry: 'x' }, { blockSize: 2 });
  for (let i = 0; i < 5; i++) w.push({ i, k: 'random', t: i, v: Math.random() });
  w.flush();
  const full = fs.readFileSync(file);
  fs.writeFileSync(file, full.subarray(0, full.length - 7)); // simulate SIGKILL during a write
  const log = readLog(file);
  assert.equal(log.truncated, true);
  assert.ok(log.events.length >= 2 && log.events.length < 5);
  assert.equal(log.header.entry, 'x');
});

test('randomness, clocks and crypto replay to identical output', async () => {
  const rec = await record(fixture('values.js'));
  assert.equal(rec.code, 0);
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'faithful');
  assert.equal(res.stdout, rec.stdout);
});

test('timer ordering replays identically, every time', async () => {
  const rec = await record(fixture('timers.js'));
  for (let i = 0; i < 3; i++) {
    const res = await replay(rec.file);
    assert.equal(res.report.status, 'faithful');
    assert.equal(res.stdout, rec.stdout);
  }
});

test('http server, fetch, http.request, raw TCP, dns and fs replay offline', async () => {
  const rec = await record(fixture('network.js'));
  assert.equal(rec.code, 0, rec.stderr);
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'faithful');
  assert.equal(res.stdout, rec.stdout);
  assert.ok(res.report.outputs.compared > 5);
  assert.equal(res.report.outputs.mismatched, 0);
  const kinds = new Set(readLog(rec.file).events.map((e) => e.k));
  for (const k of ['conn.accept', 'sock.connect', 'sock.data', 'http.req', 'op.start', 'sock.error']) assert.ok(kinds.has(k), k);
});

test('ES modules see the patched builtins (named imports)', async () => {
  const rec = await record(fixture('esm.mjs'));
  assert.equal(rec.code, 0, rec.stderr);
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'faithful');
  assert.equal(res.stdout, rec.stdout);
});

test('a crash is reproduced with the same error at the same event', async () => {
  const rec = await record(fixture('crash-always.js'));
  assert.notEqual(rec.code, 0);
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'reproduced');
  assert.equal(res.report.crash.match, true);
  assert.equal(res.report.crash.actual.message, res.report.crash.expected.message);
  assert.match(res.report.crash.actual.message, /second settle crashed: order [0-9a-f]{8}/);
});

test('signals (graceful shutdown) are recorded and replayed', async () => {
  const rec = await record(fixture('signals.js'), {
    onStdout: (text, child) => {
      const port = /ready (\d+)/.exec(text);
      if (!port) return;
      fetch(`http://127.0.0.1:${port[1]}/`).then((r) => r.text()).then(() => child.kill('SIGTERM'));
    },
  });
  assert.equal(rec.code, 0, rec.stderr);
  assert.ok(readLog(rec.file).events.some((e) => e.k === 'signal' && e.v === 'SIGTERM'));
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'faithful');
  assert.equal(res.stdout, rec.stdout);
});

test('changed code is caught as a divergence at the exact event', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'diverge-'));
  const script = path.join(dir, 'app.js');
  fs.writeFileSync(script, 'const a = Math.random();\nconst b = Date.now();\nconsole.log(a, b);\n');
  const rec = await record(script);
  fs.writeFileSync(script, 'const a = Math.random();\nconst c = Math.random();\nconsole.log(a, c);\n');
  const res = await replay(rec.file);
  assert.equal(res.report.status, 'diverged');
  assert.equal(res.report.divergence.at, 1);
  assert.equal(res.report.divergence.expected.k, 'now');
  assert.equal(res.report.divergence.actual.k, 'random');
});

test('snapshots capture app frames and locals at any event', async () => {
  const rec = await record(fixture('crash-always.js'));
  const events = readLog(rec.file).events;
  const firstRandom = events.find((e) => e.k === 'random');
  const at = await replay(rec.file, { until: firstRandom.i, snapshot: true });
  assert.equal(at.report.status, 'snapshot');
  const app = at.report.snapshot.frames.find((f) => f.kind === 'app');
  assert.ok(app, 'has an app frame');
  const names = app.scopes.flatMap((s) => s.vars.map((v) => v.name));
  assert.ok(names.includes('req') && names.includes('res'), names.join(','));

  const lastTimer = events.filter((e) => e.k === 'timer').pop();
  const step = await replay(rec.file, { until: lastTimer.i, snapshot: true });
  assert.equal(step.report.snapshot.mode, 'step-into');
  assert.equal(step.report.snapshot.pausedIn.fn, 'settle');
  const vars = step.report.snapshot.frames[0].scopes.flatMap((s) => s.vars);
  assert.ok(vars.some((v) => v.name === 'orderId' && typeof v.value === 'string'));

  const crash = events.find((e) => e.k === 'crash');
  const thrown = await replay(rec.file, { until: crash.i, snapshot: true });
  assert.equal(thrown.report.snapshot.mode, 'at-throw');
  assert.equal(thrown.report.snapshot.pausedIn.fn, 'settle');
  const atThrow = thrown.report.snapshot.pausedIn.scopes.flatMap((s) => s.vars);
  assert.ok(atThrow.some((v) => v.name === 'delay' && typeof v.value === 'number'));
});
