// Turns the raw event list into something a person can navigate:
// channels, sockets, requests (with lanes for the chart) and attributions.

import { bytesOf } from './format.js';

export const DELIVERIES = new Set([
  'timer', 'immediate', 'conn.accept', 'srv.listening', 'srv.error',
  'sock.open', 'sock.data', 'sock.eof', 'sock.error', 'sock.hangup', 'op.done', 'signal',
]);

export const CHANNELS = [
  { id: 'in', no: 1, name: 'Inbound', hint: 'connections & bytes your server received', color: '--ch-in' },
  { id: 'out', no: 2, name: 'Outbound', hint: 'sockets your app opened: db, apis', color: '--ch-out' },
  { id: 'time', no: 3, name: 'Timers', hint: 'setTimeout / setInterval / setImmediate', color: '--ch-time' },
  { id: 'rand', no: 4, name: 'Entropy', hint: 'Math.random, clocks, crypto', color: '--ch-rand' },
  { id: 'ops', no: 5, name: 'Ops', hint: 'dns, fs reads, signals', color: '--ch-ops' },
];

const SOCKET_KINDS = new Set(['sock.open', 'sock.data', 'sock.write', 'sock.end', 'sock.eof', 'sock.destroy', 'sock.error', 'sock.hangup']);

function channelOf(ev, sockets) {
  const k = ev.k;
  if (k === 'http.req' || k === 'http.res') return 'in';
  if (k === 'crash') return 'fault';
  if (k === 'sock.connect') return 'out';
  if (SOCKET_KINDS.has(k)) {
    const s = sockets.get(ev.h);
    return s && s.side === 'server' ? 'in' : 'out';
  }
  if (k.startsWith('srv.') || k === 'conn.accept') return 'in';
  if (k.startsWith('timer') || k.startsWith('immediate')) return 'time';
  if (k === 'random' || k === 'now' || k === 'perf' || k.startsWith('hrtime') || k.startsWith('crypto.')) return 'rand';
  return 'ops';
}

export function buildModel(data) {
  const { events } = data;
  const sockets = new Map();
  const requests = new Map();
  const timers = new Map();

  for (const ev of events) {
    if (ev.k === 'conn.accept' && ev.v) {
      sockets.set(ev.v.sock, { id: ev.v.sock, side: 'server', label: `client ${ev.v.peer ? ev.v.peer.port : ''}`, first: ev.i });
    } else if (ev.k === 'sock.connect') {
      const v = ev.v || {};
      sockets.set(ev.h, { id: ev.h, side: 'client', label: v.path || `${v.host}:${v.port}`, first: ev.i, owner: ev.c || 0 });
    } else if (ev.k === 'timer.set') {
      timers.set(ev.h, { id: ev.h, ms: ev.v.ms, repeat: ev.v.repeat, set: ev.i, site: ev.a || ev.s });
    } else if (ev.k === 'http.req') {
      requests.set(ev.v.rid, {
        rid: ev.v.rid, method: ev.v.method, url: ev.v.url, sock: ev.h,
        start: ev.t, end: null, status: null, startI: ev.i, endI: null, events: [],
      });
    } else if (ev.k === 'http.res' && requests.has(ev.v.rid)) {
      const r = requests.get(ev.v.rid);
      r.end = ev.t;
      r.endI = ev.i;
      r.status = ev.v.status;
      r.done = ev.v.done;
    }
  }

  // Deliveries on client sockets shared by several requests (keep-alive
  // pools, a pipelined db connection) are paired with writes FIFO: each
  // reply belongs to the oldest request still waiting on that socket.
  const wire = new Map();
  const newlines = (b) => { let n = 0; for (const x of b) if (x === 10) n++; return n; };
  for (const ev of events) {
    ev.ch = channelOf(ev, sockets);
    ev.delivery = DELIVERIES.has(ev.k);
    ev.rid = ev.c || 0;
    ev.guess = false;
    const s = SOCKET_KINDS.has(ev.k) ? sockets.get(ev.h) : null;
    if (s && s.side === 'client') {
      let st = wire.get(ev.h);
      if (!st) wire.set(ev.h, (st = { queue: [], current: 0, answered: true, lines: true }));
      if (ev.k === 'sock.write' && ev.c) {
        const b = bytesOf(ev.v);
        if (b && (b[b.length - 1] !== 10 || newlines(b) !== 1)) st.lines = false;
        const tail = st.queue[st.queue.length - 1];
        if (!(tail === ev.c && !st.answered)) st.queue.push(ev.c);
        st.answered = false;
      } else if (ev.delivery) {
        if (ev.k === 'sock.data' && st.queue.length) {
          const b = bytesOf(ev.v);
          const replies = st.lines && b ? Math.max(1, newlines(b)) : 1;
          st.current = st.queue[0];
          st.queue.splice(0, replies);
          st.answered = true;
        }
        if (st.current && st.current !== ev.c) {
          ev.rid = st.current;
          ev.guess = true;
        }
      }
    }
    if (ev.k === 'timer' && timers.has(ev.h)) ev.timer = timers.get(ev.h);
  }
  // A crash inside a callback belongs to whatever request the delivery that
  // ran the callback belonged to.
  const crashEv = events.find((e) => e.k === 'crash');
  if (crashEv && !crashEv.rid) {
    for (let i = crashEv.i - 1; i >= 0; i--) {
      if (!events[i].delivery) continue;
      if (events[i].rid) { crashEv.rid = events[i].rid; crashEv.guess = true; }
      break;
    }
  }
  for (const ev of events) if (ev.rid && requests.has(ev.rid)) requests.get(ev.rid).events.push(ev.i);
  // bytes the server received for a request precede http.req on the same socket
  for (const r of requests.values()) {
    for (let i = r.startI - 1; i >= Math.max(0, r.startI - 8); i--) {
      const before = events[i];
      if (before.k !== 'sock.data' || before.h !== r.sock) continue;
      if (!before.rid) {
        before.rid = r.rid;
        before.guess = true;
        r.events.unshift(before.i);
      }
      break;
    }
  }

  // stack request spans into lanes for the chart
  const span = events.length ? events[events.length - 1].t : 0;
  const lanes = [];
  const ordered = [...requests.values()].sort((a, b) => a.start - b.start);
  for (const r of ordered) {
    const end = r.end ?? span;
    let lane = lanes.findIndex((laneEnd) => laneEnd <= r.start);
    if (lane < 0) { lane = lanes.length; lanes.push(end); } else lanes[lane] = end;
    r.lane = lane;
  }

  const crash = crashEv || null;
  if (crash && crash.rid && requests.has(crash.rid)) requests.get(crash.rid).crashed = true;

  return {
    ...data,
    events,
    sockets,
    requests,
    timers,
    crash,
    span,
    laneCount: Math.max(1, lanes.length),
    deliveries: events.filter((e) => e.delivery).map((e) => e.i),
  };
}
