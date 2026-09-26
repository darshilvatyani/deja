'use strict';

// Signals are input from the outside world too: a graceful-shutdown handler
// that runs on SIGTERM must run at the same point of the replay.

const tape = require('../tape');

const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR2', 'SIGBREAK']);
const SIGNAL_HANDLE = 0;

function install() {
  const originalEmit = process.emit;

  const handle = {
    id: SIGNAL_HANDLE,
    ctx: 0,
    deliver(ev) {
      return originalEmit.call(process, ev.v);
    },
  };
  tape.register(handle);

  process.emit = function emit(event, ...args) {
    if (typeof event === 'string' && SIGNALS.has(event) && tape.recording() && !tape.S.done) {
      tape.deliver(handle, 'signal', event);
      return true;
    }
    return originalEmit.call(this, event, ...args);
  };

  if (tape.recording()) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const onSignal = () => {
        if (process.listenerCount(sig) > 1) {
          // The app handles this signal itself (graceful shutdown); just flush.
          tape.S.writer.flush();
          return;
        }
        tape.S.closeRecording({ exit: { signal: sig } });
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      };
      process.on(sig, onSignal);
    }
  }
}

module.exports = { install };
