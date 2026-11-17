import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { check } from '../index.mjs';
import { copyExample, edit, readJson, printed, NO_CHROME } from './support.mjs';

test('check plays every board and every tweak value', { skip: NO_CHROME, timeout: 120000 }, async (t) => {
  const ex = copyExample(t);
  const r = await printed(t, () => check(ex.config));
  assert.equal(r.result, 0, r.out);
  assert.match(r.out, /✓ Tasks\.dc\.html {2}\(\d+ elements, 5 tweak values\)/);
  assert.match(r.out, /✓ Task\.dc\.html {2}\(\d+ elements, 2 tweak values\)/);
  assert.match(r.out, /✓ Features\.dc\.html {2}\(\d+ elements, 5 tweak values\)/);
  assert.match(r.out, /All 3 boards play\./);
});

test('check fails a board with a hole that never resolves, a link to no board, or a tweak value that breaks it', { skip: NO_CHROME, timeout: 120000 }, async (t) => {
  const ex = copyExample(t);
  edit(ex.at('canvas/Features.dc.html'), (s) => s
    .replace('<p>Hello, {{name}}.', '<p>{{nothing.here}} Hello, {{name}}.')
    .replace('href="Tasks.dc.html">open the task list', 'href="Missing.dc.html">open the task list')
    .replace("step: 2,", "step: this.props.tone === 'warning' ? null.x : 2,"));
  const r = await printed(t, () => check(ex.config, ['Tasks.dc.html', 'Features.dc.html']));
  assert.equal(r.result, 1);
  assert.match(r.out, /✓ Tasks\.dc\.html/);
  assert.match(r.out, /✗ Features\.dc\.html/);
  assert.match(r.out, /- warning: \[dc\] Features\.dc\.html: \{\{ nothing\.here \}\} never resolved/);
  assert.match(r.out, /- links to a missing board: Missing\.dc\.html/);
  assert.match(r.out, /- tone = "warning": the board shows an error/);
  assert.match(r.out, /1 of 2 boards have problems\./);
  assert.ok(readJson(ex.at('canvas/canvas.json')).boards['Features.dc.html']);
  assert.ok(fs.existsSync(ex.at('canvas/ds/ex/components/bundle.js')));
});
