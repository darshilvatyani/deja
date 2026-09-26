// Client for stock-db: one persistent TCP connection, pipelined commands,
// replies matched to requests in FIFO order.

import net from 'node:net';
import { EventEmitter, once } from 'node:events';

export class StockClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port }) {
    super();
    this.inflight = [];
    this.buffer = '';
    this.socket = net.connect({ host, port });
    this.socket.setEncoding('utf8');
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('error', (err) => {
      for (const p of this.inflight.splice(0)) p.reject(err);
    });
    this.ready = once(this.socket, 'connect');
  }

  #onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const pending = this.inflight.shift();
      if (!pending) continue;
      if (line.startsWith('-')) pending.reject(new Error(line.slice(1)));
      else pending.resolve(line);
    }
  }

  #command(line) {
    return new Promise((resolve, reject) => {
      this.inflight.push({ resolve, reject });
      this.socket.write(`${line}\n`);
    });
  }

  async get(key) {
    const reply = await this.#command(`GET ${key}`);
    return reply === '$nil' ? 0 : Number(reply.slice(1));
  }

  // Resolves with the new level. Listeners of 'level' see every change first.
  decrBy(key, n, orderId) {
    return new Promise((resolve, reject) => {
      this.inflight.push({
        reject,
        resolve: (reply) => {
          const level = Number(reply.slice(1));
          this.emit('level', key, level, orderId);
          resolve(level);
        },
      });
      this.socket.write(`DECRBY ${key} ${n}\n`);
    });
  }

  close() {
    this.socket.end();
  }
}
