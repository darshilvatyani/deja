// Small formatting helpers shared by every view.

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const num = (x) => Number(x).toLocaleString('en-US');

export function fmtMs(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  const a = Math.abs(ms);
  if (a >= 10000) return `${(ms / 1000).toFixed(1)} s`;
  if (a >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (a >= 100) return `${ms.toFixed(0)} ms`;
  if (a >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const cache = new WeakMap();

export function bytesOf(v) {
  if (!v || typeof v.$b !== 'string') return null;
  if (cache.has(v)) return cache.get(v);
  const bin = atob(v.$b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cache.set(v, out);
  return out;
}

export function latin1(bytes, max = Infinity) {
  let s = '';
  const end = Math.min(bytes.length, max);
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export const printable = (bytes, max = 80) => latin1(bytes, max).replace(/\r\n/g, '↵').replace(/[^\x20-\x7e↵]/g, '·');

export function hexdump(bytes, max = 2048) {
  const lines = [];
  const end = Math.min(bytes.length, max);
  for (let off = 0; off < end; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, end));
    let hex = '';
    let asc = '';
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' ';
      if (i < row.length) {
        hex += row[i].toString(16).padStart(2, '0') + ' ';
        asc += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.';
      } else hex += '   ';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${asc}|`);
  }
  if (bytes.length > max) lines.push(`… ${num(bytes.length - max)} more bytes`);
  return lines.join('\n');
}

const HTTP_START = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE) \S+ HTTP\/1\.[01]$|^HTTP\/1\.[01] \d{3}/;

export function parseHttp(text) {
  const headEnd = text.indexOf('\r\n\r\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const lines = head.split('\r\n');
  if (!HTTP_START.test(lines[0])) return null;
  return {
    start: lines[0],
    headers: lines.slice(1).map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : [l, ''];
    }),
    body: headEnd >= 0 ? text.slice(headEnd + 4) : '',
  };
}

export function parseSite(s) {
  if (!s) return null;
  const m = /^(?:(\S+) )?(.+):(\d+):(\d+)$/.exec(s);
  if (!m) return { raw: s };
  return { fn: m[1] || null, file: m[2], line: Number(m[3]), col: Number(m[4]), raw: s };
}

export function shortSite(s) {
  const p = parseSite(s);
  if (!p || !p.file) return s || '';
  const file = p.file.replace(/^.*node_modules\//, '⌂ ').split('/').slice(-2).join('/');
  return `${p.fn ? p.fn + ' · ' : ''}${file}:${p.line}`;
}

export function describe(ev) {
  const v = ev.v;
  switch (ev.k) {
    case 'random':
      return `${v.toFixed(6)}`;
    case 'now':
      return `${v}  ${new Date(v).toISOString().slice(11, 23)}`;
    case 'perf':
      return `${v.toFixed(3)} ms`;
    case 'hrtime':
      return `[${v.join(', ')}]`;
    case 'hrtime.big':
      return `${v}n`;
    case 'crypto.uuid':
      return v;
    case 'crypto.int':
      return String(v);
    case 'crypto.bytes':
    case 'crypto.fill': {
      const b = bytesOf(v);
      return b ? Array.from(b.subarray(0, 12), (x) => x.toString(16).padStart(2, '0')).join('') + (b.length > 12 ? '…' : '') : '';
    }
    case 'timer.set':
      return `${v.ms} ms${v.repeat ? ' · interval' : ''}`;
    case 'timer':
      return 'fired';
    case 'immediate':
      return 'ran';
    case 'timer.clear':
      return 'cancelled';
    case 'sock.connect':
      return v.path ? `→ ${v.path}` : `→ ${v.host}:${v.port}${v.tls ? ' · tls' : ''}`;
    case 'sock.open':
      return v && v.peer ? `connected ${v.peer.address}:${v.peer.port}` : 'connected';
    case 'conn.accept':
      return v && v.peer ? `← ${v.peer.address}:${v.peer.port} as h${v.sock}` : 'accepted';
    case 'sock.data':
    case 'sock.write': {
      const b = bytesOf(v);
      return b ? `${fmtBytes(b.length)}  ${printable(b, 90)}` : '';
    }
    case 'sock.eof':
      return 'peer ended';
    case 'sock.end':
      return 'we ended';
    case 'sock.destroy':
      return v ? `destroyed: ${v.message}` : 'destroyed';
    case 'sock.hangup':
      return 'peer closed';
    case 'sock.error':
    case 'srv.error':
      return `${v.code || v.name}: ${v.message}`;
    case 'srv.listen':
      return v ? `${v.path || `${v.host || '::'}:${v.bound ? v.bound.port : v.port}`}${v.sync ? '' : ' · async bind'}` : '';
    case 'srv.addr':
      return v ? `${v.address}:${v.port}` : 'null';
    case 'srv.close':
      return 'closing';
    case 'http.req':
      return `${v.method} ${v.url}`;
    case 'http.res':
      return `${v.status}${v.done ? '' : ' · aborted'}`;
    case 'op.start':
      return `${v.op} ${v.hostname || v.path || ''}`;
    case 'op.done':
      return v.err ? `✘ ${v.err.code || v.err.message}` : JSON.stringify(v.res).slice(0, 90);
    case 'signal':
      return v;
    case 'crash':
      return `${v.name}: ${v.message}`;
    default:
      return v === undefined ? '' : JSON.stringify(v).slice(0, 90);
  }
}
