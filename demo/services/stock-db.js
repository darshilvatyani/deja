// stock-db — a tiny line-protocol inventory database (think: a mini Redis).
//
//   GET key          -> :<number> | $nil
//   SET key n        -> +OK
//   DECRBY key n     -> :<new value>          (atomic, but unconditional)
//   PING             -> +PONG
//
// It is deliberately a separate process spoken to over raw TCP, so the
// checkout service's recordings exercise net.Socket, not just HTTP.

import net from 'node:net';

const PORT = Number(process.env.STOCK_DB_PORT || 7401);
const data = new Map();

function execute(line) {
  const [cmd = '', key, arg] = line.trim().split(/\s+/);
  switch (cmd.toUpperCase()) {
    case 'PING':
      return '+PONG';
    case 'GET':
      return data.has(key) ? `:${data.get(key)}` : '$nil';
    case 'SET':
      data.set(key, Number(arg));
      return '+OK';
    case 'DECRBY': {
      const next = (data.get(key) ?? 0) - Number(arg);
      data.set(key, next);
      return `:${next}`;
    }
    default:
      return `-ERR unknown command '${cmd}'`;
  }
}

const server = net.createServer((sock) => {
  let pending = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) sock.write(`${execute(line)}\n`);
    }
  });
  sock.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stock-db] listening on tcp://127.0.0.1:${PORT}`);
});
