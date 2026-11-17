import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { serveExample, readJson, edit, post, rawGet, events, wait } from './support.mjs';

test('it serves the viewer, the boards, their runtime and the installed system, built before it answers', async (t) => {
  const { url } = await serveExample(t);
  const get = async (p) => { const r = await fetch(url + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
  assert.match((await get('')).text, /<title>/);
  const runtime = await get('canvas/support.js');
  assert.equal(runtime.type, 'text/javascript; charset=utf-8');
  assert.ok(runtime.text.includes('/* vendor/react/react.production.min.js */') && runtime.text.includes('/* runtime/board.js */'));
  assert.match((await get('canvas/Tasks.dc.html')).text, /class Component extends DCLogic/);
  assert.match((await get('canvas/ds/ex/components/bundle.js')).text, /^\/\* @ds-bundle: /);
  assert.match((await get('system/dist/tokens.css')).text, /--accent: #3557d4;/);
  assert.match((await get('system/components/Button/Button.stories.js')).text, /title: 'Actions\/Button'/);
  assert.equal((await get('kit/vendor/react/LICENSE')).status, 200);
  const stories = await get('kit/stories.mjs');
  assert.equal(stories.type, 'text/javascript; charset=utf-8');
  assert.match(stories.text, /export function storyElement/);
  assert.deepEqual(JSON.parse((await get('api/config')).text), { title: 'Example', system: 'Ex' });
  assert.equal(typeof JSON.parse((await get('api/me')).text).name, 'string');
  assert.deepEqual(JSON.parse((await get('api/comments')).text), { v: 1, threads: [] });
  assert.equal((await get('api/nothing')).status, 404);
});

test('a story preview page names its component; nothing but a name is taken', async (t) => {
  const { url } = await serveExample(t);
  const ok = await fetch(url + 'system/preview?c=Button');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /const name = "Button"/);
  for (const c of ['../x', '<b>', '']) assert.equal((await fetch(url + 'system/preview?c=' + encodeURIComponent(c))).status, 404, c);
});

test('no path reaches outside the folder it serves', async (t) => {
  const { url } = await serveExample(t);
  for (const p of ['/canvas/..%2fdesign.config.json', '/canvas/..%2f..%2fdesign.config.json', '/system/..%2fdesign.config.json', '/viewer/..%2fpackage.json',
    '/canvas/%2e%2e%2fdesign.config.json', '/fonts/google.css', '/canvas/', '/elsewhere']) {
    assert.equal((await rawGet(url, p)).status, 404, p);
  }
  assert.equal((await rawGet(url, '/canvas/%E0%A4%A')).status, 400);
});

test('the design system\'s description: tokens worked out, components with their stories, guides and boards', async (t) => {
  const { url } = await serveExample(t);
  const sys = await (await fetch(url + 'api/system')).json();
  assert.equal(sys.title, 'Example');
  assert.equal(sys.build.ok, true);
  assert.match(sys.readme, /^# Example/);
  assert.deepEqual(sys.groups.map((g) => [g.key, g.type]), [['color', 'color'], ['shadow', 'shadow'], ['spacing', 'dimension'], ['radius', 'dimension'], ['font', 'fontFamily'], ['typography', 'typography']]);
  const token = (k) => sys.tokens.find((x) => x.key === k);
  assert.deepEqual(token('focus'), { path: 'color.focus', key: 'focus', type: 'color', group: ['color'], description: 'The keyboard focus ring: the accent, by alias.', sample: null, alias: 'accent', value: '#3557d4' });
  assert.equal(token('shadow-pop').value, '0 8px 24px -4px rgba(22, 24, 29, 0.18), 0 0 0 1px #dde1e7');
  assert.deepEqual(token('text-title').value, { fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: '22px', fontWeight: '600', lineHeight: '1.25', letterSpacing: '-0.01em' });
  assert.equal(token('text-title').sample, 'Tasks');
  const byName = Object.fromEntries(sys.components.map((c) => [c.name, c]));
  assert.deepEqual(sys.components.map((c) => [c.name, c.group, c.stories.map((s) => s.name)]), [['Button', 'Actions', ['Primary', 'Disabled', 'Variants']], ['Badge', 'Status', ['Positive', 'Tones', 'InText']], ['Card', 'Layout', ['Basic', 'Collapsible']]]);
  assert.deepEqual(byName.Button.stories[1], {
    name: 'Disabled', title: 'Disabled',
    controls: [{ name: 'children', editor: 'text' }, { name: 'variant', editor: 'enum', options: ['primary', 'secondary', 'ghost'] }, { name: 'size', editor: 'enum', options: ['md', 'sm'] }, { name: 'disabled', editor: 'boolean' }],
    args: { children: 'Save', variant: 'primary', size: 'md', disabled: true },
  });
  assert.deepEqual(byName.Button.stories[2], { name: 'Variants', title: 'Variants', controls: [], args: {} });
  assert.deepEqual(byName.Badge.stories[2].title, 'In Text');
  assert.deepEqual(byName.Card.stories[0].controls.map((c) => c.name), ['title', 'collapsible', 'defaultOpen']);
  assert.deepEqual([byName.Card.subcomponents, byName.Card.height, byName.Card.wide], [['CardHeader'], 280, true]);
  assert.match(byName.Card.readme, /^# Card/);
  assert.match(byName.Card.types, /^export interface CardProps/);
  assert.deepEqual(byName.Button.usedOn, [{ file: 'Features.dc.html', title: 'What a board can do' }, { file: 'Task.dc.html', title: 'Task — detail' }, { file: 'Tasks.dc.html', title: 'Tasks — list' }]);
});

test('canvas edits: each held to the format, all or none, and heard by every viewer', async (t) => {
  const { url, at } = await serveExample(t);
  const ev = events(t, url);
  await ev.opened;
  const file = at('canvas/canvas.json');
  let r = await post(url + 'api/canvas', { client: 'me', ops: [{ op: 'board', file: 'Tasks.dc.html', set: { x: 10.4, y: -20, w: 99999, title: 'Renamed' } }] });
  assert.equal(r.status, 200);
  assert.deepEqual(readJson(file).boards['Tasks.dc.html'], { x: 10, y: -20, w: 8000, h: 800, title: 'Renamed', expand: 'fill', is_interactive: true, page: 'screens' });
  const heard = await ev.next('canvas');
  assert.equal(heard.data.by, 'me');
  assert.equal(heard.data.canvas.boards['Tasks.dc.html'].title, 'Renamed');

  const before = fs.readFileSync(file, 'utf8');
  for (const [ops, error] of [
    [[{ op: 'board', file: 'Nope.dc.html', set: { x: 1 } }], 'no board Nope.dc.html'],
    [[{ op: 'board', file: 'Tasks.dc.html', set: { x: 5 } }, { op: 'board', file: 'Tasks.dc.html', set: { page: 'nope' } }], 'no page nope'],
    [[{ op: 'board', file: 'Tasks.dc.html', set: { x: '5' } }], 'x must be a number'],
    [[{ op: 'note-add', id: 'bad id', note: { x: 0, y: 0, text: '' } }], 'a note id is [A-Za-z0-9_-]{1,40}'],
    [[{ op: 'note-add', id: 'n1', note: { x: 0, text: '' } }], 'a new note needs y'],
    [[{ op: 'note', id: 'about-screens', set: { fill: 'plaid' } }], 'fill is one of gray, red, orange, green, teal, blue, purple, pink'],
    [[{ op: 'note', id: 'about-screens', set: { colour: 'red' } }], 'a note edit sets x, y, w, text, fill or page'],
    [[{ op: 'teleport' }], 'unknown op teleport'],
    [[], 'ops is a list of edits'],
  ]) {
    r = await post(url + 'api/canvas', { ops });
    assert.deepEqual(r, { status: 400, body: { error } }, error);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused edit writes nothing');

  r = await post(url + 'api/canvas', { ops: [{ op: 'note-add', id: 'n1', note: { x: 1, y: 2, text: 'Hi', fill: 'teal', page: 'format' } }, { op: 'note', id: 'n1', set: { text: 'Hello', w: 10 } }] });
  assert.deepEqual(r.body.notes.n1, { x: 1, y: 2, text: 'Hello', fill: 'teal', page: 'format', w: 40 });
  r = await post(url + 'api/canvas', { ops: [{ op: 'note-delete', id: 'n1' }, { op: 'note', id: 'about-screens', set: { fill: null } }] });
  assert.deepEqual(Object.keys(r.body.notes), ['about-screens']);
  assert.equal('fill' in r.body.notes['about-screens'], false);
  // The server's own writes are not heard again from the disk.
  await wait(400);
  assert.deepEqual(ev.got.filter((e) => e.type === 'canvas').length, 2);
});

test('comments: a thread on a board or the canvas, replies, resolving, editing and deleting, signed', async (t) => {
  const { url, at } = await serveExample(t);
  const me = (await (await fetch(url + 'api/me')).json()).name;
  const call = (...ops) => post(url + 'api/comments', { ops });
  let r = await call({ op: 'add', id: 't1', board: 'Tasks.dc.html', bx: 10, by: 20, text: 'Is this the right order?' }, { op: 'add', id: 't2', page: 'screens', x: 5, y: 6, text: 'A canvas note' });
  assert.equal(r.status, 200);
  const [t1, t2] = r.body.threads;
  assert.deepEqual({ ...t1, messages: t1.messages.map((m) => [m.author, m.text]) }, { id: 't1', resolved: false, board: 'Tasks.dc.html', bx: 10, by: 20, messages: [[me, 'Is this the right order?']] });
  assert.deepEqual([t2.page, t2.x, t2.y], ['screens', 5, 6]);
  r = await call({ op: 'reply', thread: 't1', text: 'Yes' }, { op: 'resolve', thread: 't1', resolved: true });
  assert.deepEqual([r.body.threads[0].messages.length, r.body.threads[0].resolved, r.body.threads[0].resolvedBy], [2, true, me]);
  const reply = r.body.threads[0].messages[1].id;
  r = await call({ op: 'edit', thread: 't1', message: reply, text: 'Yes, newest first' }, { op: 'resolve', thread: 't1', resolved: false });
  assert.equal(r.body.threads[0].messages[1].text, 'Yes, newest first');
  assert.ok(r.body.threads[0].messages[1].edited);
  assert.equal('resolvedBy' in r.body.threads[0], false);
  r = await call({ op: 'delete', thread: 't1', message: reply }, { op: 'delete-thread', thread: 't2' });
  assert.deepEqual(r.body.threads.map((x) => [x.id, x.messages.length]), [['t1', 1]]);
  assert.deepEqual(readJson(at('comments.json')), r.body);
  for (const [op, error] of [[{ op: 'add', id: 't1', page: 'screens', x: 0, y: 0, text: 'again' }, 'a new thread needs a new id'], [{ op: 'reply', thread: 'nope', text: 'x' }, 'no thread nope'], [{ op: 'edit', thread: 't1', message: 'nope', text: 'x' }, 'no message nope']]) {
    assert.deepEqual(await call(op), { status: 400, body: { error } });
  }
});

test('live: a board, canvas.json or the design system changed on disk reaches every viewer', async (t) => {
  const { url, at } = await serveExample(t);
  const ev = events(t, url);
  await ev.opened;
  edit(at('canvas/Task.dc.html'), (s) => s.replace('Sam Rivera', 'Alex Kim'));
  assert.deepEqual((await ev.next('file', (d) => d.path === 'Task.dc.html')).data, { path: 'Task.dc.html' });

  const c = readJson(at('canvas/canvas.json'));
  c.title = 'Changed elsewhere';
  fs.writeFileSync(at('canvas/canvas.json'), JSON.stringify(c, null, 2));
  assert.equal((await ev.next('canvas')).data.canvas.title, 'Changed elsewhere');

  // A token: rebuilt, installed (heard as the installed file), then `system`.
  edit(at('system/tokens.json'), (s) => s.replace('"#3557D4"', '"#123456"'));
  const sys = await ev.next('system', () => true, 10000);
  assert.deepEqual([sys.data.ok, sys.data.errors], [true, []]);
  await ev.next('file', (d) => d.path === 'ds/ex/tokens.css');
  assert.match(fs.readFileSync(at('canvas/ds/ex/tokens.css'), 'utf8'), /--accent: #123456;/);
  assert.equal((await (await fetch(url + 'api/system')).json()).tokens.find((x) => x.key === 'accent').value, '#123456');

  // A source that fails to build says why, and the boards keep the last good build.
  const bundle = fs.readFileSync(at('canvas/ds/ex/components/bundle.js'), 'utf8');
  edit(at('system/src/index.jsx'), (s) => s + '\nexport function Broken( {\n');
  const broken = await ev.next('system', (d) => !d.ok, 10000);
  assert.match(broken.data.errors[0], /^esbuild: /);
  assert.equal(fs.readFileSync(at('canvas/ds/ex/components/bundle.js'), 'utf8'), bundle);
  const described = await (await fetch(url + 'api/system')).json();
  assert.equal(described.build.ok, false);
  assert.deepEqual(described.components.map((x) => x.name), ['Button', 'Badge', 'Card']);
});

test('fonts: a Google Fonts address is served from the system\'s fonts/, unless told to keep Google\'s', async (t) => {
  const GOOGLE = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;display=swap';
  const prepare = (ex) => {
    fs.mkdirSync(ex.at('system/fonts'));
    fs.writeFileSync(ex.at('system/fonts/google.css'), '@font-face { font-family: Inter; src: url(inter.woff2); }\n');
    edit(ex.at('canvas/Tasks.dc.html'), (s) => s.replace('<helmet>', `<helmet>\n<link href="${GOOGLE}" rel="stylesheet">`));
  };
  const local = await serveExample(t, { prepare });
  const board = await (await fetch(local.url + 'canvas/Tasks.dc.html')).text();
  assert.ok(board.includes('<link href="/fonts/google.css" rel="stylesheet">') && !board.includes('googleapis'));
  assert.match(await (await fetch(local.url + 'fonts/google.css')).text(), /font-family: Inter/);
  assert.match(await (await fetch(local.url + 'system/preview?c=Card')).text(), /<link rel="stylesheet" href="\/fonts\/google.css">/);
  const google = await serveExample(t, { prepare, fonts: false });
  assert.ok((await (await fetch(google.url + 'canvas/Tasks.dc.html')).text()).includes(GOOGLE));
});
