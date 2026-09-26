// A flash sale: buyers arrive with random (exponential) gaps and all try to
// check out the same scarce ticket.

import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const expGap = (meanMs) => -Math.log(1 - Math.random()) * meanMs;

export async function flashSale({ url = 'http://localhost:7400', buyers = 36, sku = 'tix-vip', meanGapMs = 22 } = {}) {
  const outcomes = { sold: 0, soldOut: 0, failed: 0, error: 0 };
  const inflight = [];
  for (let i = 0; i < buyers; i++) {
    const customer = `buyer-${String(i + 1).padStart(2, '0')}`;
    inflight.push(
      fetch(`${url}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku, qty: 1, customer }),
      })
        .then((res) => {
          if (res.status === 201) outcomes.sold++;
          else if (res.status === 409) outcomes.soldOut++;
          else outcomes.failed++;
          return res.arrayBuffer();
        })
        .catch(() => { outcomes.error++; }),
    );
    await sleep(expGap(meanGapMs));
  }
  await Promise.all(inflight);
  return outcomes;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await flashSale({ url: process.argv[2] }));
}
