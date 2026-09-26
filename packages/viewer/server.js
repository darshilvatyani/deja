// deja viewer — a zero-dependency local web server around one recording.
//
//   GET  /api/recording        header, trailer, every event
//   GET  /api/source?file&line  a few lines of source around a call site
//   POST /api/replay           replay the whole recording, return the report
//   POST /api/snapshot {until}  replay up to event N and capture stack + locals

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readLog } = require('@deja/runtime/log');
const { encode } = require('@deja/runtime/codec');
const launcher = require('@deja/runtime/launcher');

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export async function startViewer({ file, port = 7077, host = '127.0.0.1' }) {
  const abs = path.resolve(file);
  let log = readLog(abs);
  let payload = null;
  const snapshots = new Map();
  let replaying = null;

  const recordingJson = () => {
    if (!payload) {
      const { header, trailer, events, truncated, size } = log;
      const safeHeader = { ...header, env: Object.keys(header.env || {}).length };
      payload = `{"file":${JSON.stringify(abs)},"size":${size},"truncated":${truncated},` +
        `"header":${JSON.stringify(safeHeader)},"trailer":${JSON.stringify(trailer)},` +
        `"events":[${events.map(encode).join(',')}]}`;
    }
    return payload;
  };

  const root = log.header.cwd || process.cwd();

  const routes = {
    'GET /api/recording': (req, res) => send(res, 200, recordingJson()),

    'GET /api/source': (req, res, url) => {
      const rel = url.searchParams.get('file') || '';
      const line = Number(url.searchParams.get('line') || 1);
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return send(res, 404, { error: 'not found' });
      const lines = fs.readFileSync(target, 'utf8').split('\n');
      const start = Math.max(1, line - 7);
      const end = Math.min(lines.length, line + 7);
      return send(res, 200, { file: rel, line, start, lines: lines.slice(start - 1, end) });
    },

    'POST /api/replay': async (req, res) => {
      if (!replaying) {
        const t = Date.now();
        replaying = launcher.replay(abs, { stdio: 'pipe' }).then((r) => ({
          report: r.report,
          ms: Date.now() - t,
          stdout: r.stdout.slice(-4000),
          stderr: r.stderr.slice(-4000),
        })).finally(() => { setTimeout(() => { replaying = null; }, 0); });
      }
      try {
        send(res, 200, await replaying);
      } catch (err) {
        send(res, 500, { error: err.message });
      }
    },

    'POST /api/snapshot': async (req, res) => {
      const { until } = await readBody(req);
      const n = Number(until);
      if (!Number.isInteger(n) || n < 0 || n >= log.events.length) return send(res, 400, { error: 'bad event number' });
      if (!snapshots.has(n)) {
        const t = Date.now();
        snapshots.set(n, launcher.replay(abs, { stdio: 'pipe', until: n, snapshot: true }).then((r) => ({
          snapshot: r.report && r.report.snapshot,
          status: r.report && r.report.status,
          divergence: r.report && r.report.divergence,
          ms: Date.now() - t,
        })));
      }
      try {
        const out = await snapshots.get(n);
        if (!out.snapshot) snapshots.delete(n);
        send(res, 200, out);
      } catch (err) {
        snapshots.delete(n);
        send(res, 500, { error: err.message });
      }
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://viewer');
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return await route(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const target = path.resolve(PUBLIC, rel);
      if (!target.startsWith(PUBLIC) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return send(res, 404, 'not found', 'text/plain');
      }
      return send(res, 200, fs.readFileSync(target), TYPES[path.extname(target)] || 'application/octet-stream');
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  // Reload when the recording file is replaced (e.g. a new hunt).
  fs.watchFile(abs, { interval: 1000 }, () => {
    try {
      log = readLog(abs);
      payload = null;
      snapshots.clear();
    } catch {}
  });

  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, host, () => resolve(p));
  });
  let bound = port;
  for (let i = 0; i < 20; i++) {
    try {
      await listen(bound);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      bound++;
    }
  }
  return { url: `http://${host}:${bound}/`, server };
}
