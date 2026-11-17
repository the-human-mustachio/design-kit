import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { KIT, build, write, differs, readTokens, tokensCss, claudeTokens } from '../index.mjs';
import { buildCommand } from '../lib/build.mjs';
import { copyExample, readJson, edit, printed } from './support.mjs';

const require = createRequire(path.join(KIT, 'package.json'));

// Every kind of token, small enough to state whole.
const TINY = {
  $extensions: { 'design-kit': { name: 'Tiny', version: 2, themes: [{ id: 'light', name: 'Light' }] } },
  color: { $type: 'color', $description: 'Colours.', ink: { $value: '#ABCDEF', $description: 'Text.' }, focus: { $value: '{color.ink}' } },
  shadow: { $type: 'shadow', 'shadow-1': { $value: [{ offsetX: '0', offsetY: '1px', blur: '2px', spread: '0', color: '{color.ink}' }, { offsetX: '0', offsetY: '0', blur: '0', spread: '1px', color: '#000', inset: true }] } },
  space: { $type: 'dimension', 'space-1': { $value: '4px' } },
  font: { $type: 'fontFamily', 'font-sans': { $value: ['Open Sans', 'sans-serif'] } },
  typography: { $type: 'typography', Body: { 'text-body': { $value: { fontFamily: '{font.font-sans}', fontSize: '14px', fontWeight: 400, lineHeight: 1.5, letterSpacing: '0.01em' }, $description: 'Body.', $extensions: { 'design-kit': { sample: 'Hello' } } } } },
};
function tiny(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-kit-tokens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(TINY));
  return readTokens(path.join(dir, 'tokens.json'));
}

test('tokens as CSS: themed colours and shadows, the rest, typography as classes, aliases as var()', (t) => {
  assert.equal(tokensCss(tiny(t)), [
    '/* Tiny — generated from tokens.json */',
    ':root, [data-theme="light"] {',
    '  --ink: #abcdef;',
    '  --focus: var(--ink);',
    '  --shadow-1: 0 1px 2px var(--ink), inset 0 0 0 1px #000;',
    '}',
    ':root {',
    '  --space-1: 4px;',
    '  --font-sans: "Open Sans", sans-serif;',
    '}',
    '.text-body { font-family: var(--font-sans); font-size: 14px; line-height: 1.5; font-weight: 400; letter-spacing: 0.01em; }',
    '',
  ].join('\n'));
});

test('tokens in claude.ai\'s format', (t) => {
  assert.deepEqual(claudeTokens(tiny(t)), {
    name: 'Tiny',
    version: 2,
    color: { note: 'Colours.', themes: [{ id: 'light', name: 'Light' }], tokens: [{ name: 'ink', value: '#ABCDEF', usage: 'Text.' }, { name: 'focus', value: '{ink}' }] },
    shadow: { tokens: [{ name: 'shadow-1', value: '0 1px 2px {ink}, inset 0 0 0 1px #000' }] },
    space: { tokens: [{ name: 'space-1', value: '4px' }] },
    type: {
      fonts: [],
      families: { sans: '"Open Sans", sans-serif' },
      groups: [{ name: 'Body', family: 'sans', styles: [{ name: 'text-body', fontSize: '14px', lineHeight: 1.5, fontWeight: 400, letterSpacing: '0.01em', sample: 'Hello', usage: 'Body.' }] }],
    },
  });
});

test('the example builds: its components, the bundle\'s header, its files', async (t) => {
  const { dir, config } = copyExample(t);
  const r = await build(config);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.components, ['Button', 'Badge', 'Card']);
  assert.deepEqual(r.keys, ['Button', 'Badge', 'Card', 'CardHeader']);
  assert.deepEqual(r.untyped, []);
  assert.ok(r.js.startsWith('/* @ds-bundle: {"format":4,"namespace":"Ex","components":[{"name":"Button"},{"name":"Badge"},{"name":"Card"}]} */\n'));
  const rel = (f) => path.relative(dir, f);
  assert.deepEqual(Object.keys(r.files).map(rel).sort(), ['canvas/ds/ex/components/bundle.css', 'canvas/ds/ex/components/bundle.js', 'canvas/ds/ex/tokens.css',
    'system/dist/bundle.css', 'system/dist/bundle.js', 'system/dist/index.d.ts', 'system/dist/index.mjs', 'system/dist/tokens.css']);
  assert.deepEqual(Object.keys(r.json).map(rel), ['canvas/ds/ex/tokens.json']);
  const types = r.files[path.join(dir, 'system/dist/index.d.ts')];
  assert.ok(types.startsWith("import type * as React from 'react';\n"));
  assert.ok(types.includes('declare const Ex: {\n  Button: typeof Button;\n  Badge: typeof Badge;\n  Card: typeof Card;\n  CardHeader: typeof CardHeader;\n};\nexport default Ex;'));
});

test('the boards\' bundle reads React from the page, and holds none of its own', async (t) => {
  const { config } = copyExample(t);
  const { js } = await build(config);
  assert.ok(js.length < 12000, 'the bundle is ' + js.length + ' characters: React came with it');
  const made = [];
  const React = { createElement: (type, props, ...children) => { made.push(type); return { type, props, children }; }, useState: (v) => [v, () => {}] };
  const win = { React, Ex: { Kept: 1 } };
  vm.runInNewContext(js, { window: win });
  assert.deepEqual(Object.keys(win.Ex), ['Kept', 'Button', 'Badge', 'Card', 'CardHeader']);
  win.Ex.Card({ title: 'T', children: 'x' });
  assert.deepEqual(made, [win.Ex.CardHeader, 'div', 'section']);
});

test('the app\'s module imports React and renders on a server', async (t) => {
  const { dir, config } = copyExample(t);
  const r = await build(config);
  // Beside the kit, so its import of react resolves to the kit's.
  const out = fs.mkdtempSync(path.join(KIT, 'test', '.out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fs.writeFileSync(path.join(out, 'index.mjs'), r.files[path.join(dir, 'system/dist/index.mjs')]);
  const Ex = (await import(pathToFileURL(path.join(out, 'index.mjs')).href)).default;
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  assert.equal(renderToStaticMarkup(React.createElement(Ex.Card, { title: 'T', collapsible: true }, 'Body')),
    '<section class="ex-card" aria-label="T"><header class="ex-card__head"><h2 class="ex-card__title text-body">T</h2><button type="button" class="ex-card__toggle" aria-expanded="true">Hide</button></header><div class="ex-card__body">Body</div></section>');
  assert.equal(renderToStaticMarkup(React.createElement(Ex.Button, { href: 'a.html', variant: 'primary' }, 'Go')), '<a class="ex-btn ex-btn--primary" href="a.html">Go</a>');
});

test('a file is written only when it changes; a JSON file only when its value does', async (t) => {
  const { dir, config, at } = copyExample(t);
  const first = write(await build(config));
  assert.equal(first.length, 9);
  assert.deepEqual(write(await build(config)), []);
  // The same value laid out otherwise is kept as it is.
  fs.writeFileSync(at('canvas/ds/ex/tokens.json'), JSON.stringify(readJson(at('canvas/ds/ex/tokens.json'))));
  assert.deepEqual(differs(await build(config)), []);
  edit(at('system/tokens.json'), (s) => s.replace('"#3557D4"', '"#123456"'));
  assert.deepEqual(differs(await build(config)).map((f) => path.relative(dir, f)).sort(),
    ['canvas/ds/ex/tokens.css', 'canvas/ds/ex/tokens.json', 'system/dist/tokens.css']);
});

test('build --check: exit 1 while anything built differs from disk, 0 after a build; every story renders', async (t) => {
  const { config } = copyExample(t);
  const stale = await printed(t, () => buildCommand(config, { check: true }));
  assert.equal(stale.result, 1);
  assert.match(stale.out, /9 files are not as the source builds them\./);
  assert.match(stale.out, /All 8 stories render\./);
  assert.equal((await printed(t, () => buildCommand(config))).result, 0);
  const fresh = await printed(t, () => buildCommand(config, { check: true }));
  assert.equal(fresh.result, 0);
  assert.match(fresh.out, /Everything built is as on disk\./);
});

test('a story that throws fails the build', async (t) => {
  const { config, at } = copyExample(t);
  edit(at('system/components/Badge/Badge.stories.js'), (s) => s + "\nexport const Broken = () => { throw new Error('boom'); };\n");
  const r = await printed(t, () => buildCommand(config));
  assert.equal(r.result, 1);
  assert.match(r.out, /✗ story Badge\/Broken: boom/);
  assert.match(r.out, /1 of 9 stories failed\./);
});

test('the build refuses what would break a board', async (t) => {
  const cases = [
    ['an alias to no token', (ex) => edit(ex.at('system/tokens.json'), (s) => s.replace('"{color.accent}"', '"{color.nope}"')),
      ['color.focus refers to {color.nope}, which is no token']],
    ['a key used twice', (ex) => edit(ex.at('system/tokens.json'), (s) => s.replace('"space-1": { "$value": "4px" }', '"space-1": { "$value": "4px" }, "ground": { "$value": "2px" }')),
      ['spacing.ground and color.ground are both --ground']],
    ['a token with no type', (ex) => edit(ex.at('system/tokens.json'), (s) => s.replace('"color": {', '"misc": { "x": { "$value": "1" } },\n  "color": {')),
      ['misc.x has no $type, nor has its group']],
    ['a variable nothing defines', (ex) => edit(ex.at('system/src/bundle.css'), (s) => s + '.x { color: var(--nope); }\n'),
      ['bundle.css uses variables nothing defines: --nope']],
    ['a component folder that isn\'t in the namespace', (ex) => fs.mkdirSync(ex.at('system/components/Ghost')),
      ['components/Ghost/ is not in the Ex object']],
  ];
  for (const [what, change, errors] of cases) {
    const ex = copyExample(t);
    change(ex);
    assert.deepEqual((await build(ex.config)).errors, errors, what);
  }
  const ex = copyExample(t);
  edit(ex.at('system/src/index.jsx'), (s) => s + '\nexport function Broken( {\n');
  const [e] = (await build(ex.config)).errors;
  assert.match(e, /^esbuild: .*src\/index\.jsx:\d+: /);
});

test('a component without types is named', async (t) => {
  const { config, at } = copyExample(t);
  fs.rmSync(at('system/components/Badge/Badge.d.ts'));
  assert.deepEqual((await build(config)).untyped, ['Badge']);
});
