# déjà — record & replay debugging for Node.js

> "Here's a bug that happened once. Here it is again. And again. Every time."

`deja` records every source of nondeterminism in a running Node.js service —
incoming connections and bytes, outgoing network responses, timers, `Math.random()`,
the clock, crypto entropy, DNS, file reads, signals — into a compact log. Later it
replays that exact execution on your laptop: **no network, no dependencies, virtual
time**, same callbacks in the same order, same crash at the same event. Then you step
through it, event by event, and inspect the program's state at any moment.

It runs on **stock Node** (≥ 22.15, developed on 25): no native addon, no patched
runtime — the whole runtime is plain JavaScript preloaded with `--require`.

```
$ npm run demo:hunt                                  # "production": flash sales until the bug hits
  sale  1  sold 4  sold-out 32  failed 0   stock 0   ✔ fine
  sale  2  sold 4  sold-out 22  failed 10  stock -1  ✘ checkout CRASHED
  Error: INVARIANT VIOLATED: stock:tix-vip went to -1 after ord_9469c24d — oversold

$ npx deja replay recordings/crash.deja              # dependencies are shut down now
  déjà ▸ replay  recordings/crash.deja
  events   479 / 479 replayed in 0.13s (recorded span 0.62s)
  outputs  64 socket writes verified, 0 mismatched
  crash    ✔ reproduced at #478 — Error: INVARIANT VIOLATED: … after ord_9469c24d — oversold
  verdict  REPRODUCED
```

---

## Quick start

```bash
npm install                      # links the workspaces; the runtime itself has zero dependencies
npm test                         # 11 tests incl. a fuzzer of random async programs
npm run demo:hunt                # record flash sales until the rare overselling crash happens
npx deja replay recordings/crash.deja
npx deja verify recordings/crash.deja      # replay 5×, require identical results
npx deja view recordings/crash.deja        # the viewer (http://127.0.0.1:7077)
```

Recording your own app:

```bash
npx deja record -o recordings/mine.deja -- node server.js --port 3000
# … use it, Ctrl-C when done (or let it crash)
npx deja replay recordings/mine.deja
```

## The idea

A single-threaded JavaScript program is deterministic once two things hold:

1. every nondeterministic **value** it reads is the same, and
2. every externally-triggered **callback** runs in the same order.

Promises, `process.nextTick` and microtasks are already deterministic given (1) and
(2), so they are not recorded. That leaves one ordered log ("the tape") with three
families of events:

| family | examples | recording | replay |
|---|---|---|---|
| **values** — the app pulls them | `Math.random`, `Date.now`, `new Date()`, `performance.now`, `process.hrtime`, `crypto.randomUUID/randomBytes/randomInt/getRandomValues`, `server.address()` | logged with their value | returned from the tape |
| **structure / output** — the app does it | `timer.set`, `timer.clear`, `sock.connect`, `sock.write` (bytes), `srv.listen`, `op.start`, `http.req/res` | logged | **verified** (kind, handle, bytes, call site) |
| **deliveries** — the world pushes them | timer fired, immediate ran, connection accepted, bytes arrived, peer hung up, DNS/fs result, SIGTERM | logged when they happen | performed by the scheduler, one per macrotask, in recorded order |

Replay is a single cursor walking the tape. The app consumes values/structure itself;
when the cursor reaches a delivery, the **scheduler** performs it and lets the
resulting microtasks drain before the next one — exactly the quiescence that existed
between two real macrotasks while recording. Timers are virtual, so a one-hour
recording replays in seconds.

### Divergence detection

Every app-side event carries its call site. If the replayed program asks for
`Math.random()` where the recording says `Date.now()` happened, the replay stops and
tells you **the exact event and both call sites**. Replaying against modified code
therefore shows precisely where behaviour changed. Output bytes are compared too
(`N socket writes verified`).

### Sockets: one mechanism for everything on net/tls

The app never touches a real socket. `net.Socket#connect`, `tls.connect` and
`net.Server` connections are replaced by **handle-less fake `net.Socket`s**:

* recording — the fake is bridged to a real socket that deja owns; its events become
  deliveries and are pushed into the fake;
* replay — the scheduler pushes recorded chunks (with the original chunk boundaries)
  into the fake; nothing touches the network.

Because the app sees the same object type in both modes, stream internals behave
identically, and one mechanism covers `http`, `https` clients, `fetch` (undici),
the `http.Server`, Fastify/Express, raw TCP clients (DB drivers, Redis) …

### Time travel

`deja replay --until N --snapshot` (or **State @ N** in the viewer) re-runs the tape up
to event N inside a fresh process and pauses there with an **in-process inspector
session**:

* app-side event → the app's frames are already on the stack: read their scopes;
* delivery → single-step into the first line of *your* code that the event triggers;
* the crash itself → pause-on-exception at the `throw`, before the stack unwinds.

Replay is fast and deterministic, so "step back" is simply "replay to N-1".
`--inspect` attaches Chrome DevTools / VS Code instead, with a `debugger` stop at N.

## The demo: a heisenbug in a flash sale

`demo/` contains a realistic little system:

* **checkout** (Fastify, the service we record): read stock → subtract in-flight
  reservations → reserve for 250 ms → charge the card → `DECRBY` stock;
* **stock-db**: a line-protocol TCP database (think mini-Redis) — raw `net.Socket`;
* **payments**: a card gateway over HTTP with long-tailed latency and 4% 503s — `fetch`
  with `AbortSignal.timeout` and jittered retries.

The bug: a reservation expires (`Date.now()` + 250 ms) while a slow payment is still in
flight, a second buyer sees the "free" unit, both are charged, stock goes to -1, a
tripwire throws. It needs a tail-latency payment **and** a buyer arriving in the window
— roughly one sale in eight. `hunt.js` runs recorded sales until it happens, keeps that
recording, shuts the dependencies down, and the replay reproduces it with the same
order id every time.

In the viewer, open *State @ crash*: paused on the throwing line with `level = -1` and the
`orderId` in scope. Then walk backwards through the `now` reads in `reservedUnits()`
(filter the tape by `reservedUnits`) — each one is a stop where you can take a snapshot
and see the `holds` map as it was at that moment.

## CLI

```
deja record [-o file.deja] [--label text] [--no-stacks] -- node app.js [args]
deja replay <file> [--until N] [--snapshot] [--inspect] [--report out.json] [--json] [--no-sites]
deja verify <file> [--runs 5]
deja info   <file> [--json]
deja cat    <file> [--from N] [--to N] [--kind a,b] [--req N] [--json]
deja view   <file> [--port 7077] [--no-open]
```

Replay exit codes: `0` faithful / reproduced / snapshot, `1` otherwise. `--report` writes
the JSON verdict (status, counts, outputs compared, divergence, crash match, snapshot).

## The viewer

`deja view` serves a local, zero-dependency web app (vanilla JS modules, no build step)
designed as a **strip-chart recorder** for your event loop:

* **Paper** ink (graph paper, pen colours) and **Phosphor** ink (oscilloscope CRT);
  follows the OS setting, `t` toggles.
* **§1 Strip chart** — one channel per source (inbound, outbound, timers, entropy,
  ops). `▼` world→app deliveries, `│` app→world actions, request spans with status,
  timer waits, a pen trace of every `Math.random()` value, the crash line. ⌘-scroll /
  `+ −` to zoom, drag to pan, overview brush below.
* **§2 Tape** — every event (virtualised), channel filters, per-request filter, search
  over kinds, payload text and `file:line`.
* **§3 Inspector** — the event (HTTP/text/hex views of bytes, source around the call
  site), the **request story** (every event of one request, including replies on shared
  sockets paired FIFO), and **State @ N** (time travel, see above).
* **Replay this crash** runs the replay server-side and stamps the verdict.

Keys: `j/k` step · `J/K` world events · `c` crash · `s` state · `/` find · `+ − 0` zoom.

## Layout

```
packages/runtime   CommonJS, zero dependencies — preloaded with --require
  register.js        entry (DEJA_MODE=record|replay)
  src/originals.js   pristine references captured before patching
  src/tape.js        the log cursor: values / marks / deliveries, divergence, reports
  src/log.js         .deja format: header + independently-compressed zstd NDJSON blocks
  src/scheduler.js   replay: one delivery per macrotask, idle detection
  src/snapshot.js    in-process inspector: capture-here, step-into, pause-at-throw
  src/patches/       values · timers · net (fake sockets) · ops (dns, fs) · process (signals)
  src/launcher.js    spawn helpers used by the CLI, viewer and demo
packages/cli       `deja` command
packages/viewer    local server + static UI
demo/              checkout (Fastify) · stock-db · payments · hunt/traffic/bench scripts
test/              node:test suites + fixtures + fuzzer
```

## Numbers (M-series laptop, Node 25)

`node demo/scripts/bench.js` — small JSON API, keep-alive, concurrency 32:

| mode | req/s | overhead |
|---|---|---|
| plain node | ~17,000 | — |
| `deja record --no-stacks` | ~15,000 | ~14% |
| `deja record` (with call sites) | ~7,500 | ~2.3× slower |

Call sites (`Error.captureStackTrace`) dominate the cost; they power divergence
reports and the viewer's "where did this happen". Recordings are ~290 bytes per
request with zstd. Replays run faster than real time (virtual clock).

## Limits (by design, for now)

* **Replay starts at process start.** A "last 5 minutes" flight recorder would need
  heap snapshots.
* Not recorded: `worker_threads`, `child_process`, `dgram`, `fs` APIs other than
  `readFile` (sync fs and `createReadStream` run for real), native addons doing I/O,
  `WeakRef`/`FinalizationRegistry` timing, `SharedArrayBuffer`.
* **Inbound TLS** (`https.Server`) and HTTP/2 are not bridged — terminate TLS in front,
  as most deployments do. Outbound TLS is recorded as plaintext after decryption.
* Node core stamps the HTTP `Date:` header from its own clock; output verification
  masks that header.
* Replay must run the same code (the header stores node version, git revision, argv,
  env with secrets redacted); a mismatch surfaces as a divergence with both call sites.

## Prior art

rr (Mozilla), Replay.io and Microsoft's Jardis / Node-ChakraCore TTD achieve
record/replay by modifying the runtime; nock, Polly.js and Keploy record HTTP traffic
but not callback ordering, timers or randomness. deja's contribution is doing the full
thing — ordering included — in user land on an unmodified Node.
