import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sync } from '../index.mjs';
import { copyExample, readJson, edit, printed } from './support.mjs';

// The canvas as claude.ai would hand it back: a copy of this one's files, to change.
function theirs(ex) {
  const dir = ex.at('theirs/project');
  fs.cpSync(ex.at('canvas'), dir, { recursive: true });
  return dir;
}
const run = (t, ex, ...args) => printed(t, () => sync(ex.config, args));

test('status before any sync, record, then what changed here since', async (t) => {
  const ex = copyExample(t);
  assert.match((await run(t, ex, 'status')).out, /Never synced/);
  const rec = await run(t, ex, 'record', '--version', 'v1', '--artifact', 'https://example.test/a');
  assert.equal(rec.result, 0);
  const lock = readJson(ex.config.sync);
  assert.deepEqual([lock.artifact, lock.version, Object.keys(lock.files).sort()], ['https://example.test/a', 'v1', ['Features.dc.html', 'Task.dc.html', 'Tasks.dc.html', 'canvas.json']]);
  assert.match((await run(t, ex, 'status')).out, /Last synced with https:\/\/example\.test\/a at version v1 .*\nNothing has changed here since\./);
  edit(ex.at('canvas/Tasks.dc.html'), (s) => s.replace('New task', 'Add task'));
  fs.writeFileSync(ex.at('canvas/Extra.dc.html'), '<!doctype html>');
  fs.rmSync(ex.at('canvas/Features.dc.html'));
  const st = await run(t, ex, 'status');
  assert.match(st.out, /  changed  Tasks\.dc\.html\n  added    Extra\.dc\.html\n  removed  Features\.dc\.html/);
  assert.match(st.out, /note: canvas\.json lists Features\.dc\.html, but there is no such file/);
  assert.match(st.out, /note: Extra\.dc\.html is not in canvas\.json/);
});

test('stage: what changed since the last sync, laid out for the Artifact call', async (t) => {
  const ex = copyExample(t);
  await run(t, ex, 'record', '--version', 'v1', '--artifact', 'https://example.test/a');
  assert.match((await run(t, ex, 'stage', ex.at('out'))).out, /Nothing to publish/);
  edit(ex.at('canvas/Tasks.dc.html'), (s) => s.replace('New task', 'Add task'));
  fs.rmSync(ex.at('canvas/Features.dc.html'));
  const out = await run(t, ex, 'stage', ex.at('out'));
  assert.deepEqual(JSON.parse(out.out), { url: 'https://example.test/a', root: ex.at('out'), file_path: ex.at('out/project/Tasks.dc.html'), files: { 'project/Features.dc.html': null } });
  assert.equal(fs.readFileSync(ex.at('out/project/Tasks.dc.html'), 'utf8'), fs.readFileSync(ex.at('canvas/Tasks.dc.html'), 'utf8'));
});

test('pull: each side\'s changes kept, canvas.json merged entry by entry', async (t) => {
  const ex = copyExample(t);
  await run(t, ex, 'record', '--version', 'v1');
  const dir = theirs(ex);
  // There: a note added and a board's text changed. Here: a board moved.
  const c = readJson(path.join(dir, 'canvas.json'));
  c.notes.theirs = { x: 0, y: 0, text: 'From claude.ai', page: 'format' };
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify(c, null, 2));
  edit(path.join(dir, 'Task.dc.html'), (s) => s.replace('Sam Rivera', 'Alex Kim'));
  const here = readJson(ex.at('canvas/canvas.json'));
  here.boards['Tasks.dc.html'].x = 500;
  fs.writeFileSync(ex.at('canvas/canvas.json'), JSON.stringify(here, null, 2));

  const r = await run(t, ex, 'pull', dir, '--version', 'v2');
  assert.equal(r.result, 0);
  assert.match(r.out, /Pulled version v2: 1 taken from claude\.ai, 0 removed as claude\.ai removed them, canvas\.json merged\./);
  const merged = readJson(ex.at('canvas/canvas.json'));
  assert.equal(merged.boards['Tasks.dc.html'].x, 500);
  assert.equal(merged.notes.theirs.text, 'From claude.ai');
  assert.deepEqual(merged.order, ['Tasks.dc.html', 'Task.dc.html', 'Features.dc.html']);
  assert.match(fs.readFileSync(ex.at('canvas/Task.dc.html'), 'utf8'), /Alex Kim/);
  assert.equal(readJson(ex.config.sync).version, 'v2');
});

test('pull: what both sides changed differently stops it, with nothing written, until --theirs or --ours', async (t) => {
  const ex = copyExample(t);
  await run(t, ex, 'record', '--version', 'v1');
  const dir = theirs(ex);
  edit(path.join(dir, 'Task.dc.html'), (s) => s.replace('Sam Rivera', 'There'));
  edit(ex.at('canvas/Task.dc.html'), (s) => s.replace('Sam Rivera', 'Here'));
  const before = fs.readFileSync(ex.at('canvas/Task.dc.html'), 'utf8');
  const stopped = await run(t, ex, 'pull', dir, '--version', 'v2');
  assert.equal(stopped.result, 1);
  assert.match(stopped.out, /Both sides changed these since the last sync, so nothing was written:\n  Task\.dc\.html/);
  assert.equal(fs.readFileSync(ex.at('canvas/Task.dc.html'), 'utf8'), before);
  assert.equal(readJson(ex.config.sync).version, 'v1');
  assert.equal((await run(t, ex, 'pull', dir, '--version', 'v2', '--ours')).result, 0);
  assert.match(fs.readFileSync(ex.at('canvas/Task.dc.html'), 'utf8'), /Here/);
  edit(path.join(dir, 'Task.dc.html'), (s) => s.replace('There', 'There again'));
  assert.equal((await run(t, ex, 'pull', dir, '--version', 'v3', '--theirs')).result, 0);
  assert.match(fs.readFileSync(ex.at('canvas/Task.dc.html'), 'utf8'), /There again/);
});

test('sync refuses a command it lacks what it needs for', async (t) => {
  const ex = copyExample(t);
  assert.deepEqual([(await run(t, ex, 'pull', ex.at('canvas'))).result, (await run(t, ex, 'record')).result, (await run(t, ex, 'nope')).result, (await run(t, ex)).result], [1, 1, 1, 0]);
});
