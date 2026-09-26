// checkout — flash-sale checkout service (the one we record).
//
// Flow for POST /checkout:
//   1. read the stock level from stock-db
//   2. subtract in-flight reservations; 409 if nothing is left
//   3. reserve the units for RESERVATION_TTL_MS
//   4. charge the card through the payment gateway (retries on 5xx)
//   5. DECRBY the stock, release the reservation, return the receipt
//
// It works. Almost always.

import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { StockClient } from './stock-client.js';
import { charge } from './payments-client.js';

const PORT = Number(process.env.PORT || 7400);
const STOCK_DB_PORT = Number(process.env.STOCK_DB_PORT || 7401);
const RESERVATION_TTL_MS = 250; // "the gateway answers in ~50ms, 250ms is plenty"

const PRICES = { 'tix-vip': 24900, 'tix-floor': 12900, 'tix-ga': 6900 };

const stock = new StockClient({ port: STOCK_DB_PORT });
const holds = new Map(); // sku -> [{ id, qty, until }]
const stats = { orders: 0, soldOut: 0, failed: 0 };

// Overselling is the one bug we can never ship quietly: crash loudly instead.
stock.on('level', (key, level, orderId) => {
  if (level < 0) {
    throw new Error(`INVARIANT VIOLATED: ${key} went to ${level} after ${orderId} — oversold`);
  }
});

let priceCache = { at: 0, table: null };
function priceOf(sku) {
  if (!priceCache.table || Date.now() - priceCache.at > 1000) {
    priceCache = { at: Date.now(), table: { ...PRICES } };
  }
  return priceCache.table[sku];
}

function reservedUnits(sku) {
  const now = Date.now();
  const live = (holds.get(sku) || []).filter((h) => h.until > now);
  holds.set(sku, live);
  return live.reduce((sum, h) => sum + h.qty, 0);
}

function reserve(sku, qty) {
  const h = { id: randomUUID(), qty, until: Date.now() + RESERVATION_TTL_MS };
  holds.set(sku, [...(holds.get(sku) || []), h]);
  return h;
}

function release(sku, hold) {
  holds.set(sku, (holds.get(sku) || []).filter((h) => h.id !== hold.id));
}

const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true }));
app.get('/stats', async () => stats);

app.post('/checkout', async (req, reply) => {
  const { sku, qty = 1, customer = 'anonymous' } = req.body || {};
  const orderId = `ord_${randomUUID().slice(0, 8)}`;
  const price = priceOf(sku);
  if (!price) return reply.code(404).send({ error: 'unknown sku', sku });

  const onShelf = await stock.get(`stock:${sku}`);
  const available = onShelf - reservedUnits(sku);
  if (available < qty) {
    stats.soldOut++;
    return reply.code(409).send({ error: 'sold out', orderId });
  }

  const hold = reserve(sku, qty);
  const started = performance.now();
  try {
    const receipt = await charge({ amount: price * qty, customer, orderId });
    const left = await stock.decrBy(`stock:${sku}`, qty, orderId);
    stats.orders++;
    const ms = Math.round(performance.now() - started);
    console.log(`[checkout] ${orderId} ${customer} paid ${receipt.id} in ${ms}ms, ${left} left`);
    return reply.code(201).send({ orderId, receipt: receipt.id, left });
  } catch (err) {
    stats.failed++;
    return reply.code(502).send({ error: 'payment failed', orderId, detail: err.message });
  } finally {
    release(sku, hold);
  }
});

process.on('SIGINT', async () => {
  await app.close();
  stock.close();
  process.exit(0);
});

await stock.ready;
await app.listen({ port: PORT, host: 'localhost' });
console.log(`[checkout] listening on http://localhost:${PORT}`);
