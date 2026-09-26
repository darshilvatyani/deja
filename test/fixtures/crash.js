// Crashes only when two random draws line up — about one run in four.
const http = require('node:http');

const inventory = { widget: 1 };
const server = http.createServer((req, res) => {
  const delay = Math.floor(Math.random() * 30);
  const stockSeen = inventory.widget;
  setTimeout(function commit() {
    if (stockSeen > 0) inventory.widget -= 1;
    if (inventory.widget < 0) throw new Error(`oversold: widget=${inventory.widget}`);
    res.end(`ok ${delay}\n`);
  }, delay);
});

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  const buy = () => fetch(`http://127.0.0.1:${port}/buy`).then((r) => r.text()).catch(() => 'failed');
  const results = await Promise.all([buy(), new Promise((r) => setTimeout(r, Math.random() * 40)).then(buy)]);
  console.log(results.join(''));
  server.close();
  process.exit(0);
});
