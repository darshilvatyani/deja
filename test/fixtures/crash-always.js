// Always crashes, but *where* and with *which* order id depends on randomness
// and on the order in which two concurrent requests finish.
const http = require('node:http');
const { randomUUID } = require('node:crypto');

let finished = 0;
const server = http.createServer((req, res) => {
  const orderId = randomUUID().slice(0, 8);
  const delay = Math.floor(Math.random() * 20);
  setTimeout(function settle() {
    finished++;
    if (finished === 2) throw new Error(`second settle crashed: order ${orderId} after ${delay}ms`);
    res.end(orderId);
  }, delay);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  for (let i = 0; i < 2; i++) fetch(`http://127.0.0.1:${port}/o${i}`).catch(() => {});
});
