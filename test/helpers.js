import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const launcher = require('@deja/runtime/launcher');
export const { readLog } = require('@deja/runtime/log');

export const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deja-test-'));

let n = 0;

// Records `script` and resolves once the process exits.
export function record(script, { onStdout, env = {} } = {}) {
  const file = path.join(tmp, `${path.basename(script)}-${++n}.deja`);
  const child = launcher.record(['node', script], {
    output: file,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { DEJA_ANNOUNCE: '0', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (onStdout) onStdout(String(d), child);
  });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ file, stdout, stderr, code, signal }));
  });
}

export const replay = (file, opts) => launcher.replay(file, { stdio: 'pipe', ...opts });
