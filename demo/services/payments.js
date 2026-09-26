// payments — a fake card-payment gateway with realistic, long-tailed latency
// and the occasional 503. Like any third-party API: usually fast, sometimes not.

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PAYMENTS_PORT || 7402);
const charges = new Map(); // idempotency-key -> charge

function latencyMs() {
  const r = Math.random();
  if (r < 0.84) return 15 + Math.random() * 70; //   84%  15–85ms
  if (r < 0.97) return 90 + Math.random() * 140; // 13%  90–230ms
  return 300 + Math.random() * 400; //                 3%  300–700ms  (the tail)
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/v1/charges') return send(res, 404, { error: 'not_found' });

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const key = req.headers['idempotency-key'];

  setTimeout(() => {
    if (key && charges.has(key)) return send(res, 200, charges.get(key));
    if (Math.random() < 0.04) return send(res, 503, { error: 'gateway_busy', retry: true });
    const charge = {
      id: `ch_${randomBytes(6).toString('hex')}`,
      status: 'captured',
      amount: body.amount,
      currency: body.currency,
      customer: body.customer,
    };
    if (key) charges.set(key, charge);
    send(res, 201, charge);
  }, latencyMs());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[payments] listening on http://127.0.0.1:${PORT}`);
});
