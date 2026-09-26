// Ordering that differs from run to run in plain Node: setTimeout(0) vs
// setImmediate from the main module, timers racing with real I/O, jitter.
const { setTimeout: sleep } = require('node:timers/promises');
const trace = [];
const log = (x) => trace.push(x);

setTimeout(() => log('timeout0'), 0);
setImmediate(() => log('immediate'));

for (let i = 0; i < 6; i++) {
  const delay = Math.floor(Math.random() * 20);
  setTimeout(() => log(`t${i}@${delay}`), delay);
}

let ticks = 0;
const iv = setInterval(() => {
  log(`tick${++ticks}`);
  if (ticks === 3) clearInterval(iv);
}, 7);

const cancelled = setTimeout(() => log('never'), 5);
clearTimeout(cancelled);

(async () => {
  await sleep(12);
  log('slept');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 3);
  try { await sleep(1000, null, { signal: ac.signal }); } catch (e) { log(e.name); }
  let n = 0;
  for await (const _ of require('node:timers/promises').setInterval(4)) { if (++n === 2) break; }
  log('iter-done');
})();

// a busy loop of random length makes timer coalescing vary between runs
const until = Date.now() + Math.random() * 15;
while (Date.now() < until) {}

setTimeout(() => console.log(JSON.stringify(trace)), 80);
