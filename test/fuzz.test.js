// Property test: generate random async programs (timers, immediates,
// nextTicks, microtasks, intervals, randomness, clock reads, busy loops that
// perturb timing), record each one, replay it, and require identical traces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, record, replay } from './helpers.js';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function program(seed) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let id = 0;
  const block = (depth) => {
    const lines = [];
    const count = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < count; i++) {
      const n = id++;
      const inner = depth < 3 ? block(depth + 1) : '';
      const op = pick(['timeout', 'timeout', 'immediate', 'tick', 'micro', 'promise', 'branch', 'busy', 'interval']);
      if (op === 'timeout') lines.push(`setTimeout(() => { log('t${n}'); ${inner} }, Math.floor(Math.random() * ${1 + Math.floor(rnd() * 12)}));`);
      if (op === 'immediate') lines.push(`setImmediate(() => { log('i${n}'); ${inner} });`);
      if (op === 'tick') lines.push(`process.nextTick(() => { log('n${n}'); ${inner} });`);
      if (op === 'micro') lines.push(`queueMicrotask(() => { log('q${n}'); ${inner} });`);
      if (op === 'promise') lines.push(`new Promise((r) => setTimeout(r, ${Math.floor(rnd() * 6)})).then(() => { log('p${n}'); ${inner} });`);
      if (op === 'branch') lines.push(`if (Math.random() < 0.5) { log('b${n}:' + (Date.now() % 7)); ${inner} } else { log('B${n}'); }`);
      if (op === 'busy') lines.push(`{ const end = performance.now() + Math.random() * 3; while (performance.now() < end) {} log('w${n}'); }`);
      if (op === 'interval') lines.push(`{ let k = 0; const iv = setInterval(() => { log('v${n}.' + k); if (++k === 3) clearInterval(iv); }, ${1 + Math.floor(rnd() * 4)}); }`);
    }
    return lines.join('\n');
  };
  return `const trace = []; const log = (x) => trace.push(x);\n${block(0)}\nsetTimeout(() => console.log(trace.join(' ')), 120);\n`;
}

const SEEDS = Array.from({ length: 16 }, (_, i) => 1000 + i * 7919);

test('random async programs replay identically', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fuzz-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  for (const seed of SEEDS) {
    const script = path.join(dir, `prog-${seed}.js`);
    fs.writeFileSync(script, program(seed));
    const rec = await record(script);
    assert.equal(rec.code, 0, rec.stderr);
    const res = await replay(rec.file);
    assert.equal(res.report.status, 'faithful', `seed ${seed}: ${JSON.stringify(res.report.divergence)}`);
    assert.equal(res.stdout, rec.stdout, `seed ${seed} trace differs`);
  }
});
