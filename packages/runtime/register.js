'use strict';

// Preload entry:  node --require @deja/runtime/register app.js
// Configured through environment variables (set by the `deja` CLI):
//   DEJA_MODE=record|replay   DEJA_FILE=path.deja
//   DEJA_UNTIL=<event#>  DEJA_SNAPSHOT=1  DEJA_INSPECT=1  DEJA_REPORT=path.json

const mode = process.env.DEJA_MODE;
if (mode === 'record' || mode === 'replay') {
  const env = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('DEJA_')) delete process.env[key];
  require('./src/index.js').start(mode, env);
}
