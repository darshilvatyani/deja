// Terminal formatting helpers.

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

export const n = (x) => Number(x).toLocaleString('en-US');

export function bytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

const printable = (buf, max = 60) =>
  JSON.stringify(Buffer.from(buf).subarray(0, max).toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '·')) +
  (buf.length > max ? '…' : '');

export function describe(ev) {
  const v = ev.v;
  switch (ev.k) {
    case 'random':
    case 'now':
    case 'perf':
    case 'crypto.int':
      return String(v);
    case 'hrtime':
      return JSON.stringify(v);
    case 'hrtime.big':
      return `${v}n`;
    case 'crypto.uuid':
      return v;
    case 'crypto.bytes':
    case 'crypto.fill':
      return Buffer.from(v).toString('hex').slice(0, 32);
    case 'timer.set':
      return `${v.ms}ms${v.repeat ? ' (interval)' : ''}`;
    case 'sock.connect':
      return v.path ? `→ ${v.path}` : `→ ${v.host}:${v.port}${v.tls ? ' (tls)' : ''}`;
    case 'sock.open':
      return v && v.peer ? `connected to ${v.peer.address}:${v.peer.port}` : 'connected';
    case 'conn.accept':
      return v && v.peer ? `← ${v.peer.address}:${v.peer.port} as h${v.sock}` : 'accepted';
    case 'sock.data':
    case 'sock.write':
      return `${v.length}B ${printable(v)}`;
    case 'sock.error':
    case 'srv.error':
      return `${v.code || v.name}: ${v.message}`;
    case 'srv.listen':
      return v ? `${v.path || `${v.host || '::'}:${v.bound ? v.bound.port : v.port}`}${v.sync ? '' : ' (async)'}` : '';
    case 'srv.addr':
      return v ? `${v.address}:${v.port}` : 'null';
    case 'http.req':
      return `#${v.rid} ${v.method} ${v.url}`;
    case 'http.res':
      return `#${v.rid} → ${v.status}${v.done ? '' : ' (aborted)'}`;
    case 'op.start':
      return `${v.op} ${v.hostname || v.path || ''}`;
    case 'op.done':
      return v.err ? `✘ ${v.err.code || v.err.message}` : JSON.stringify(v.res).slice(0, 70);
    case 'crash':
      return `${v.name}: ${v.message}`;
    default:
      return v === undefined ? '' : JSON.stringify(v).slice(0, 70);
  }
}
