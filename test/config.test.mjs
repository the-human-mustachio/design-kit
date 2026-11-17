import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findConfig, loadConfig } from '../index.mjs';
import { copyExample } from './support.mjs';

test('findConfig: --config, then $DESIGN_CONFIG, then design.config.json or design/design.config.json here', (t) => {
  const { dir } = copyExample(t);
  assert.equal(findConfig({ argv: ['node', 'x', '--config', 'a/b.json'], env: { DESIGN_CONFIG: 'c.json' }, cwd: dir }), path.join(dir, 'a/b.json'));
  assert.equal(findConfig({ argv: [], env: { DESIGN_CONFIG: 'c.json' }, cwd: dir }), path.join(dir, 'c.json'));
  assert.equal(findConfig({ argv: [], env: {}, cwd: dir }), path.join(dir, 'design.config.json'));
  const inner = path.join(dir, 'nested');
  fs.mkdirSync(path.join(inner, 'design'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'design.config.json'), path.join(inner, 'design/design.config.json'));
  assert.equal(findConfig({ argv: [], env: {}, cwd: inner }), path.join(inner, 'design/design.config.json'));
  assert.throws(() => findConfig({ argv: [], env: {}, cwd: path.join(dir, 'system') }), /No design\.config\.json/);
});

test('loadConfig: every path from the config\'s folder, and the defaults', (t) => {
  const { dir, config } = copyExample(t);
  assert.deepEqual(config, {
    file: path.join(dir, 'design.config.json'),
    root: dir,
    title: 'Example',
    system: { dir: path.join(dir, 'system'), namespace: 'Ex', install: path.join(dir, 'canvas/ds/ex'), esbuild: {} },
    canvas: { dir: path.join(dir, 'canvas'), artifact: null },
    comments: path.join(dir, 'comments.json'),
    sync: path.join(dir, 'sync.json'),
    fonts: null,
  });
});

test('loadConfig: fonts when the system has fonts/google.css; no system; refusals', (t) => {
  const { at } = copyExample(t);
  fs.mkdirSync(at('system/fonts'));
  fs.writeFileSync(at('system/fonts/google.css'), '');
  assert.equal(loadConfig(at('design.config.json')).fonts, at('system/fonts'));

  const write = (v) => { fs.writeFileSync(at('other.json'), JSON.stringify(v)); return () => loadConfig(at('other.json')); };
  const bare = write({ canvas: { dir: 'canvas' } })();
  assert.equal(bare.system, null);
  assert.equal(bare.title, null);
  assert.equal(write({ system: { dir: 'system' }, canvas: { dir: 'canvas' } })().system.namespace, 'DS');
  assert.throws(write({ system: { dir: 'system' } }), /canvas\.dir is required/);
  assert.throws(write({ system: { dir: 'system', namespace: 'not ok' }, canvas: { dir: 'canvas' } }), /namespace must be a JavaScript name/);
});
