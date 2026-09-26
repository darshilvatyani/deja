// An http server, a raw TCP echo server and clients (fetch, http.request,
// net.connect) racing each other inside one process.
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const trace = [];
const log = (x) => trace.push(x);

const echo = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (d) => setTimeout(() => { if (!sock.writableEnded) sock.write(`echo:${d}`); }, Math.random() * 10));
});

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const wait = Math.floor(Math.random() * 25);
  setTimeout(() => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, body, wait, id: Math.random().toString(36).slice(2, 8) }));
  }, wait);
});

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, path, method: 'POST' }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.end(`body-of-${path}`);
  });
}

server.listen(0, '127.0.0.1', () => {
  echo.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const echoPort = echo.address().port;

    const lookedUp = await dns.promises.lookup('localhost', { family: 4 });
    log(`dns:${lookedUp.address}`);
    const own = await fs.promises.readFile(__filename, 'utf8');
    log(`file:${own.length}`);

    const tcp = net.connect(echoPort, '127.0.0.1');
    const tcpDone = new Promise((resolve) => {
      let got = '';
      tcp.on('data', (d) => { got += d; if (['a', 'b', 'c'].every((ch) => got.includes(ch))) { tcp.end(); resolve(got.length); } });
    });
    tcp.on('connect', () => { tcp.write('a'); setTimeout(() => tcp.write('b'), 3); setTimeout(() => tcp.write('c'), 6); });

    const results = await Promise.all([
      fetch(`http://127.0.0.1:${port}/f1`, { method: 'POST', body: 'x' }).then((r) => r.text()),
      request(port, '/r1'),
      fetch(`http://localhost:${port}/f2`).then((r) => r.json()).then((j) => JSON.stringify(j)),
      request(port, '/r2'),
    ]);
    for (const r of results) log(r);
    log(await tcpDone);

    const refused = await new Promise((resolve) => net.connect(1, '127.0.0.1').on('error', (e) => resolve(e.code)));
    log(`refused:${refused}`);

    console.log(JSON.stringify(trace, null, 1));
    server.close();
    echo.close();
  });
});
