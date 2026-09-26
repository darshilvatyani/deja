#!/usr/bin/env node
import * as commands from '../src/commands.js';
import { c } from '../src/format.js';

const HELP = `
  ${c.bold('déjà')} — record a Node.js service, replay its bugs exactly

  ${c.dim('usage')}
    deja record [-o file.deja] [--label text] [--no-stacks] -- node app.js [args]
    deja replay <file.deja> [--until N] [--snapshot] [--inspect] [--report out.json] [--json] [--no-sites]
    deja verify <file.deja> [--runs 5]
    deja info   <file.deja> [--json]
    deja cat    <file.deja> [--from N] [--to N] [--kind a,b] [--req N] [--json]
    deja view   <file.deja> [--port 7077] [--no-open]

  ${c.dim('replay flags')}
    --until N     stop at event N (with --inspect: pause there in DevTools)
    --snapshot    with --until, print the call stack + local variables at event N
    --inspect     start under the inspector and wait for chrome://inspect / VS Code
    --no-sites    don't compare call sites between recording and replay
`;

function parse(argv) {
  const opts = {};
  const positional = [];
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--no-')) { opts[a.slice(5)] = false; continue; }
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) opts[key] = inline;
      else if (next !== undefined && !next.startsWith('-') && !['inspect', 'snapshot', 'json'].includes(key)) { opts[key] = next; i++; }
      else opts[key] = true;
      continue;
    }
    if (a === '-o') { opts.o = argv[++i]; continue; }
    if (a === '-h') { opts.help = true; continue; }
    positional.push(a);
  }
  return { opts, positional, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  const { opts, positional, rest } = parse(argv);
  if (cmd === 'record') return commands.record(opts, rest.length ? rest : positional);
  if (!(cmd in commands)) {
    console.error(`unknown command "${cmd}"\n${HELP}`);
    return 1;
  }
  return commands[cmd](opts, positional);
}

main().then(
  (code) => { if (typeof code === 'number') process.exitCode = code; },
  (err) => { console.error(c.red(`deja: ${err.message}`)); process.exitCode = 1; },
);
