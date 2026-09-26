// Recording overhead: requests/second against the same service, plain vs
// under `deja record`, same load (keep-alive, fixed concurrency).
//
//   node demo/scripts/bench.js [--requests 4000] [--concurrency 32]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const launcher = require('@deja/runtime/launcher');
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'bench', 'target.js');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TOTAL = arg('requests', 4000);
const CONCURRENCY = arg('concurrency', 32);
const PORT = 7499;

function ready(child) {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    child.on('exit', () => reject(new Error('target exited')));
  });
}

async function load() {
  let sent = 0;
  const latencies = [];
  const worker = async () => {
    while (sent < TOTAL) {
      sent++;
      const t = performance.now();
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      await res.arrayBuffer();
      latencies.push(performance.now() - t);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  return { rps: TOTAL / secs, p50: latencies[Math.floor(latencies.length * 0.5)], p99: latencies[Math.floor(latencies.length * 0.99)] };
}

async function run(label, child) {
  await ready(child);
  await load(); // warm-up round
  const r = await load();
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('exit', resolve));
  return { label, ...r };
}

const plain = await run('plain node', spawn(process.execPath, [target], { stdio: ['ignore', 'pipe', 'inherit'] }));
const file = path.join(os.tmpdir(), `deja-bench-${Date.now()}.deja`);
const recorded = await run('deja record', launcher.record(['node', target], { output: file, stdio: ['ignore', 'pipe', 'inherit'], env: { DEJA_ANNOUNCE: '0' } }));
const noStacks = await run('deja record --no-stacks', launcher.record(['node', target], { output: `${file}.2`, stacks: false, stdio: ['ignore', 'pipe', 'inherit'], env: { DEJA_ANNOUNCE: '0' } }));

const size = fs.statSync(file).size;
console.log(`\n  ${TOTAL} requests × 2 rounds, concurrency ${CONCURRENCY}\n`);
for (const r of [plain, recorded, noStacks]) {
  const overhead = r === plain ? '' : `   ${((1 - r.rps / plain.rps) * 100).toFixed(0)}% slower`;
  console.log(`  ${r.label.padEnd(24)} ${r.rps.toFixed(0).padStart(6)} req/s   p50 ${r.p50.toFixed(2)}ms   p99 ${r.p99.toFixed(2)}ms${overhead}`);
}
console.log(`\n  recording size: ${(size / 1024).toFixed(0)} KB for ${TOTAL * 2} requests (${(size / TOTAL / 2).toFixed(0)} B/request, zstd)\n`);
fs.rmSync(file, { force: true });
fs.rmSync(`${file}.2`, { force: true });
