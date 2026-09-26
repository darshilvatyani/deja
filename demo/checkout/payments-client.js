// Calls the payment gateway with fetch(), retrying 5xx with jittered backoff.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.PAYMENTS_URL || 'http://127.0.0.1:7402';

export async function charge({ amount, customer, orderId }) {
  const idempotencyKey = randomUUID();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ amount, currency: 'usd', customer, metadata: { orderId } }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    lastError = new Error(`gateway said ${res.status} ${body.error || ''}`.trim());
    if (res.status < 500) throw lastError;
    const backoff = 40 * 2 ** attempt * (0.5 + Math.random()); // jitter avoids retry storms
    await sleep(backoff);
  }
  throw lastError;
}
