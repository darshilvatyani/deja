'use strict';

// Spawning helpers shared by the CLI, the viewer and the demo scripts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readHeader } = require('./log');

const REGISTER = path.join(__dirname, '..', 'register.js');

function stripNode(command) {
  const out = { execArgv: [], script: null, args: [] };
  let rest = [...command];
  if (rest.length && /(^|\/)node(\.exe)?$/.test(rest[0])) {
    rest = rest.slice(1);
    while (rest.length && rest[0].startsWith('-')) out.execArgv.push(rest.shift());
  }
  out.script = rest.shift() || null;
  out.args = rest;
  return out;
}

// Starts `node --require register <script>` in record mode. Returns the child.
function record(command, { output, label, stacks = true, stdio = 'inherit', env = {}, cwd = process.cwd() } = {}) {
  const { execArgv, script, args } = stripNode(command);
  if (!script) throw new Error('nothing to record: pass a script, e.g. `deja record app.js`');
  const file = path.resolve(cwd, output || `recordings/${path.basename(script, path.extname(script))}-${Date.now()}.deja`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const child = spawn(process.execPath, [...execArgv, '--require', REGISTER, script, ...args], {
    cwd,
    stdio,
    env: {
      ...process.env,
      ...env,
      DEJA_MODE: 'record',
      DEJA_FILE: file,
      DEJA_STACKS: stacks ? '1' : '0',
      ...(label ? { DEJA_LABEL: label } : {}),
    },
  });
  child.recordingFile = file;
  return child;
}

// Replays a recording in a child process and resolves with its report.
function replay(file, opts = {}) {
  const {
    until = null,
    snapshot = false,
    inspect = false,
    checkSites = true,
    stdio = 'pipe',
    timeoutMs = 120000,
    quiet = stdio === 'pipe',
    extraExecArgv = [],
  } = opts;
  const abs = path.resolve(file);
  const header = readHeader(abs);
  if (!header.entry || !fs.existsSync(header.entry)) {
    return Promise.reject(new Error(`the recorded entry script is missing: ${header.entry}`));
  }
  const reportFile = path.join(os.tmpdir(), `deja-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const cwd = header.cwd && fs.existsSync(header.cwd) ? header.cwd : process.cwd();
  const execArgv = [...(header.execArgv || []), ...extraExecArgv];
  const child = spawn(process.execPath, [...execArgv, '--require', REGISTER, header.entry, ...(header.argv || [])], {
    cwd,
    stdio,
    env: {
      ...process.env,
      DEJA_MODE: 'replay',
      DEJA_FILE: abs,
      DEJA_REPORT: reportFile,
      DEJA_QUIET: quiet ? '1' : '0',
      DEJA_CHECK_SITES: checkSites ? '1' : '0',
      ...(until !== null && until !== undefined ? { DEJA_UNTIL: String(until) } : {}),
      ...(snapshot ? { DEJA_SNAPSHOT: '1' } : {}),
      ...(inspect ? { DEJA_INSPECT: '1' } : {}),
    },
  });

  const cap = (limit) => {
    let text = '';
    return { push: (d) => { if (text.length < limit) text += d; }, get: () => text };
  };
  const out = cap(200000);
  const err = cap(200000);
  if (child.stdout) child.stdout.on('data', out.push);
  if (child.stderr) child.stderr.on('data', err.push);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        fs.unlinkSync(reportFile);
      } catch {}
      resolve({ report, code, signal, stdout: out.get(), stderr: err.get(), header });
    });
  });
}

module.exports = { REGISTER, record, replay, stripNode };
