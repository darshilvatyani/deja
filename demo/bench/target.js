// Benchmark target: a small JSON API that touches every patched source
// (randomness, clocks, crypto, timers, a socket per request).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const server = http.createServer((req, res) => {
  const id = randomUUID();
  const started = performance.now();
  setImmediate(() => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, lucky: Math.random(), at: Date.now(), took: performance.now() - started }));
  });
});
server.listen(Number(process.env.PORT || 7499), '127.0.0.1', () => console.log('ready'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
