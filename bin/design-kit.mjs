#!/usr/bin/env node
// design-kit <command>: serve, build, check or sync a project's design canvas and design system. The project is its
// design.config.json: --config <file>, $DESIGN_CONFIG, or design.config.json / design/design.config.json here.
import { findConfig, loadConfig } from '../lib/config.mjs';

const HELP = `design-kit <command> [--config <file>]

  serve [--port <n>]          the viewer, at http://127.0.0.1:4400/; rebuilds the design system as it changes
  build [--check]             builds the design system and installs it for the boards; renders every story
  check [board.dc.html ...]   plays every board and every tweak value in headless Chrome
  sync <status|pull|stage|record> ...   keeps the canvas in step with a copy on claude.ai`;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
// The words that aren't flags or their values.
const words = argv.filter((a, i) => !a.startsWith('--') && !['--config', '--port', '--version', '--artifact'].includes(argv[i - 1]));
const cmd = words[0];

if (!cmd || cmd === 'help' || argv.includes('--help')) { console.log(HELP); process.exit(0); }
let config;
try { config = loadConfig(findConfig()); } catch (e) { console.error(e.message); process.exit(1); }

if (cmd === 'serve') {
  const { serve } = await import('../lib/serve.mjs');
  await serve(config, Number(flag('--port') || process.env.PORT || 4400));
} else if (cmd === 'build') {
  const { buildCommand } = await import('../lib/build.mjs');
  process.exit(await buildCommand(config, { check: argv.includes('--check') }));
} else if (cmd === 'check') {
  const { check } = await import('../lib/check.mjs');
  process.exit(await check(config, words.slice(1)));
} else if (cmd === 'sync') {
  const { sync } = await import('../lib/sync.mjs');
  process.exit(sync(config, argv.slice(argv.indexOf('sync') + 1)));
} else {
  console.error('No command ' + cmd + '.\n\n' + HELP);
  process.exit(1);
}
