// "Production": run flash sales against the checkout service — recorded by
// deja — until the rare overselling crash happens. Keep that recording.
//
//   node demo/scripts/hunt.js [--max 30] [--stock 4]

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { flashSale } from './traffic.js';

const require = createRequire(import.meta.url);
const launcher = require('@deja/runtime/launcher');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const recordings = path.join(root, 'recordings');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MAX = arg('max', 30);
const STOCK = arg('stock', 4);

const ink = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = ink('2');
const red = ink('1;31');
const green = ink('32');
const bold = ink('1');

function startService(file, name) {
  const child = spawn(process.execPath, [path.join(here, '..', 'services', file)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    child.stdout.once('data', (d) => {
      process.stdout.write(dim(String(d)));
      resolve(child);
    });
    child.name = name;
  });
}

function stockCommand(line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(7401, '127.0.0.1', () => sock.write(`${line}\n`));
    sock.setEncoding('utf8');
    sock.once('data', (d) => { sock.end(); resolve(d.trim()); });
    sock.once('error', reject);
  });
}

async function waitForHealth(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('checkout exited during startup');
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('checkout did not become healthy');
}

async function main() {
  fs.mkdirSync(recordings, { recursive: true });
  console.log(`\n  ${bold('flash sale bug hunt')} ${dim(`— up to ${MAX} sales of ${STOCK} VIP tickets, each recorded by deja`)}\n`);
  const services = [await startService('stock-db.js', 'stock-db'), await startService('payments.js', 'payments')];

  let caught = null;
  try {
    for (let attempt = 1; attempt <= MAX; attempt++) {
      await stockCommand(`SET stock:tix-vip ${STOCK}`);
      const file = path.join(recordings, `attempt-${attempt}.deja`);
      const child = launcher.record(['node', path.join(root, 'demo', 'checkout', 'server.js')], {
        output: file,
        label: `flash sale #${attempt}`,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { DEJA_ANNOUNCE: '0' },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

      await waitForHealth('http://localhost:7400/health', child);
      const outcome = await flashSale({ url: 'http://localhost:7400' });
      await sleep(150);

      const level = await stockCommand('GET stock:tix-vip');
      const crashed = child.exitCode !== null;
      const line = `  sale ${String(attempt).padStart(2)}  sold ${outcome.sold}  sold-out ${outcome.soldOut}  failed ${outcome.failed + outcome.error}  stock ${level.slice(1)}`;

      if (crashed) {
        await exited;
        console.log(`${line}  ${red('✘ checkout CRASHED')}`);
        const why = stderr.split('\n').find((l) => l.startsWith('Error:')) || '';
        console.log(`\n  ${red(why)}`);
        caught = path.join(recordings, 'crash.deja');
        fs.renameSync(file, caught);
        break;
      }
      console.log(`${line}  ${green('✔ fine')}`);
      child.kill('SIGINT');
      await exited;
      if (attempt === 1) fs.renameSync(file, path.join(recordings, 'clean.deja'));
      else fs.rmSync(file, { force: true });
    }
  } finally {
    for (const s of services) s.kill();
  }

  if (!caught) {
    console.log(`\n  ${dim(`no crash in ${MAX} sales — run it again (it's rare, that's the point)`)}\n`);
    return;
  }
  const rel = path.relative(process.cwd(), caught);
  console.log(`
  ${bold('the bug happened once — and it was recorded.')}
  stock-db and the payment gateway are shut down now. Reproduce it anyway:

    ${green(`npx deja replay ${rel}`)}         ${dim('# same crash, same order id, offline')}
    ${green(`npx deja verify ${rel}`)}         ${dim('# replay it 5× — identical every time')}
    ${green(`npx deja view ${rel}`)}           ${dim('# timeline, request story, time-travel snapshots')}
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
