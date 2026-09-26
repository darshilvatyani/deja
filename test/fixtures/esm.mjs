import { setTimeout as sleep, setImmediate as yieldNow } from 'node:timers/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as cbTimeout } from 'node:timers';
import { readFile } from 'node:fs/promises';

const out = [];
cbTimeout(() => out.push('cb-timer'), 3);
await sleep(Math.random() * 10);
out.push(randomUUID(), randomBytes(4).toString('hex'), Date.now());
await yieldNow();
out.push((await readFile(new URL(import.meta.url), 'utf8')).length);
await sleep(5);
console.log(JSON.stringify(out));
