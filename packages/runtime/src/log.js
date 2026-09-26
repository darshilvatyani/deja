'use strict';

// .deja file layout
//
//   "DEJA" u8(version)
//   frame*   where frame = u8(type) u32be(length) payload
//     type 1  header   JSON (uncompressed)
//     type 2  events   compressed NDJSON block
//     type 3  trailer  JSON (uncompressed), written at exit
//
// Blocks are compressed independently so a crash (or SIGKILL) only loses the
// events that were still buffered in memory, never the whole file.

const fs = require('node:fs');
const zlib = require('node:zlib');
const O = require('./originals');
const { encode, decode } = require('./codec');

const MAGIC = Buffer.from('DEJA');
const VERSION = 1;
const FRAME = { HEADER: 1, EVENTS: 2, TRAILER: 3 };

const CODECS = {
  zstd: {
    available: typeof zlib.zstdCompressSync === 'function',
    compress: (b) => zlib.zstdCompressSync(b),
    decompress: (b) => zlib.zstdDecompressSync(b),
  },
  gzip: {
    available: true,
    compress: (b) => zlib.gzipSync(b, { level: 4 }),
    decompress: (b) => zlib.gunzipSync(b),
  },
  none: { available: true, compress: (b) => b, decompress: (b) => b },
};

function pickCodec(preferred) {
  if (preferred && CODECS[preferred] && CODECS[preferred].available) return preferred;
  return CODECS.zstd.available ? 'zstd' : 'gzip';
}

class LogWriter {
  constructor(file, header, { codec, blockSize = 4096 } = {}) {
    this.file = file;
    this.codec = pickCodec(codec);
    this.blockSize = blockSize;
    this.buffer = [];
    this.bytes = 0;
    this.count = 0;
    this.closed = false;
    this.fd = O.openSync(file, 'w');
    this._write(Buffer.concat([MAGIC, Buffer.from([VERSION])]));
    this._frame(FRAME.HEADER, Buffer.from(JSON.stringify({ ...header, codec: this.codec })));
  }

  push(event) {
    if (this.closed) return;
    this.buffer.push(event);
    this.count++;
    if (this.buffer.length >= this.blockSize) this.flush();
  }

  flush() {
    if (this.closed || this.buffer.length === 0) return;
    const text = this.buffer.map(encode).join('\n');
    this.buffer = [];
    this._frame(FRAME.EVENTS, CODECS[this.codec].compress(Buffer.from(text)));
  }

  close(trailer) {
    if (this.closed) return;
    this.flush();
    this._frame(FRAME.TRAILER, Buffer.from(JSON.stringify(trailer || {})));
    O.closeSync(this.fd);
    this.closed = true;
  }

  _frame(type, payload) {
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(payload.length, 1);
    this._write(head);
    this._write(payload);
  }

  _write(buf) {
    let off = 0;
    while (off < buf.length) off += O.writeSync(this.fd, buf, off, buf.length - off);
    this.bytes += buf.length;
  }
}

function readLog(file) {
  const buf = O.readFileSync(file);
  if (buf.length < 5 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`${file} is not a deja recording`);
  }
  const version = buf[4];
  if (version !== VERSION) throw new Error(`unsupported recording version ${version}`);

  let header = null;
  let trailer = null;
  let truncated = false;
  const events = [];
  let off = 5;
  while (off < buf.length) {
    if (off + 5 > buf.length) { truncated = true; break; }
    const type = buf.readUInt8(off);
    const len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) { truncated = true; break; }
    const payload = buf.subarray(off + 5, off + 5 + len);
    off += 5 + len;
    if (type === FRAME.HEADER) header = JSON.parse(payload.toString());
    else if (type === FRAME.TRAILER) trailer = JSON.parse(payload.toString());
    else if (type === FRAME.EVENTS) {
      const text = CODECS[header.codec].decompress(payload).toString();
      for (const line of text.split('\n')) if (line) events.push(decode(line));
    }
  }
  if (!header) throw new Error(`${file} has no header`);
  return { header, events, trailer, truncated: truncated || !trailer, size: buf.length };
}

// Reads only the header frame (cheap, for launching replays).
function readHeader(file) {
  const fd = O.openSync(file, 'r');
  try {
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (!head.subarray(0, 4).equals(MAGIC)) throw new Error(`${file} is not a deja recording`);
    const len = head.readUInt32BE(6);
    const body = Buffer.alloc(len);
    fs.readSync(fd, body, 0, len, 10);
    return JSON.parse(body.toString());
  } finally {
    O.closeSync(fd);
  }
}

module.exports = { LogWriter, readLog, readHeader, pickCodec };
