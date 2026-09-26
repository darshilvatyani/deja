'use strict';

const { syncBuiltinESMExports } = require('node:module');
require('./originals'); // capture pristine references before anything is patched
const tape = require('./tape');

let started = false;

function start(mode, env = process.env) {
  if (started) return;
  started = true;
  if (mode === 'record') tape.initRecord(env);
  else if (mode === 'replay') tape.initReplay(env);
  else throw new Error(`deja: unknown mode "${mode}"`);

  require('./patches/values').install();
  require('./patches/timers').install();
  require('./patches/net').install();
  require('./patches/ops').install();
  require('./patches/process').install();
  // Make `import { setTimeout } from 'node:timers'` & co. see the patches.
  syncBuiltinESMExports();

  if (mode === 'replay') {
    if (tape.S.inspect) {
      const inspector = require('node:inspector');
      if (!inspector.url()) inspector.open(0);
      process._rawDebug(`\n  déjà ⏸  waiting for a debugger on ${inspector.url()}\n` +
        '     open chrome://inspect (or attach VS Code) to start the replay\n');
      inspector.waitForDebugger();
    }
    require('./scheduler').start();
  }
}

module.exports = { start, tape };
