// Serves a project's design canvas and design system on this machine (`design-kit serve`): start({ config, port }).
//
//   /                    the viewer (viewer/), which reads the canvas's canvas.json
//   /canvas/<file>       the canvas's files: the boards, canvas.json and the design system it installed
//   /canvas/support.js   the boards' runtime, each board's ./support.js: React 18 and runtime/board.js, put together on
//                        each request
//   /fonts/<file>        the design system's fonts (its fonts/). A Google Fonts css2 address in a board or a
//                        stylesheet is served as /fonts/google.css, so the boards need no connection; FONTS=google
//                        keeps Google's
//   /system/<file>       the design system's folder: its components' stories and docs, and dist/, what it builds
//   /system/preview?c=<Name>   a page that renders that component's stories, and takes their args from the viewer's
//                        controls
//   /kit/vendor/<file>   React, for the preview pages; /kit/stories.mjs, what a story file means (stories.mjs)
//   /api/...             what the viewer saves and hears:
//                          GET  me         the name comments are signed with (git config user.name)
//                          GET  config     the project's title, and its design system's namespace (null if none)
//                          GET  canvas     canvas.json      POST canvas    { ops, client }: moves, sizes, titles, notes
//                          GET  comments   comments.json    POST comments  { ops, client }
//                          GET  system     the design system: its README, tokens, components, the boards each is
//                                          used on, and how its last build went
//                          GET  events     a stream: `canvas` and `comments` when either changes, `file` when a board,
//                                          the installed design system or the runtime changes on disk, `system` when
//                                          the design system's source does (after it is rebuilt), `viewer` when the
//                                          viewer does
//
// The design system is built on start and again whenever its source changes (build.mjs), and installed where the
// boards load it, so a change to a component reaches every board that uses it. Nothing is cached. It listens on
// 127.0.0.1 only. Edits are written to canvas.json and the comments file as they are made; an edit to any file on disk
// reaches every open viewer.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { KIT } from './config.mjs';
import * as ds from './build.mjs';
import { writtenOrder, storyTitle, storyArgs, storyControls } from './stories.mjs';

const RUNTIME = ['vendor/react/react.production.min.js', 'vendor/react/react-dom.production.min.js', 'runtime/board.js'];
const GOOGLE_FONTS = /https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]*/g;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// ---- canvas.json and comments.json -------------------------------------------------------------------------------------

const FILLS = new Set(['gray', 'red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink']);
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export class Refused extends Error {}
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');

function readJson(file, empty) {
  if (!fs.existsSync(file)) return empty;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value, known) {
  const text = JSON.stringify(value, null, 2) + '\n';
  known.set(file, hash(text));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function num(v, lo, hi, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Refused(what + ' must be a number');
  return Math.round(Math.min(hi, Math.max(lo, v)));
}
function text(v, max, what) {
  if (typeof v !== 'string') throw new Refused(what + ' must be text');
  if (v.length > max) throw new Refused(what + ' is longer than ' + max);
  return v;
}

// One edit to canvas.json, held to its format: a frame 40–8000 px, a note's id [A-Za-z0-9_-]{1,40}, a sticky's fill one
// of eight. Anything the edit doesn't name is kept as it is.
export function applyCanvas(c, op) {
  const pageIds = (c.pages || []).map((p) => p.id);
  const page = (v) => { if (!pageIds.includes(v)) throw new Refused('no page ' + v); return v; };
  if (op.op === 'board') {
    const b = c.boards && c.boards[op.file];
    if (!b) throw new Refused('no board ' + op.file);
    const s = op.set || {};
    if ('x' in s) b.x = num(s.x, -1e6, 1e6, 'x');
    if ('y' in s) b.y = num(s.y, -1e6, 1e6, 'y');
    if ('w' in s) b.w = num(s.w, 40, 8000, 'w');
    if ('h' in s) b.h = num(s.h, 40, 8000, 'h');
    if ('title' in s) { if (s.title === null || s.title === '') delete b.title; else b.title = text(s.title, 200, 'title'); }
    if ('page' in s) b.page = page(s.page);
  } else if (op.op === 'note' || op.op === 'note-add') {
    c.notes = c.notes || {};
    if (!ID.test(op.id || '')) throw new Refused('a note id is [A-Za-z0-9_-]{1,40}');
    if (op.op === 'note-add' && c.notes[op.id]) throw new Refused('there is already a note ' + op.id);
    if (op.op === 'note' && !c.notes[op.id]) throw new Refused('no note ' + op.id);
    const n = op.op === 'note-add' ? {} : c.notes[op.id];
    const s = op.op === 'note-add' ? op.note || {} : op.set || {};
    if (op.op === 'note-add') { for (const k of ['x', 'y', 'text']) if (!(k in s)) throw new Refused('a new note needs ' + k); }
    for (const [k, v] of Object.entries(s)) {
      if (k === 'x' || k === 'y') n[k] = num(v, -1e6, 1e6, k);
      else if (k === 'w' || k === 'maxW' || k === 'maxH') n[k] = num(v, 40, 8000, k);
      else if (k === 'text') n.text = text(v, 20000, 'text');
      else if (k === 'fill') { if (v === null) delete n.fill; else if (FILLS.has(v)) n.fill = v; else throw new Refused('fill is one of ' + [...FILLS].join(', ')); }
      else if (k === 'page') n.page = page(v);
      else if (op.op === 'note-add') n[k] = v;   // a deleted note put back by an undo keeps every key it had
      else throw new Refused('a note edit sets x, y, w, text, fill or page');
    }
    if (op.op === 'note-add') c.notes[op.id] = n;
  } else if (op.op === 'note-delete') {
    if (!c.notes || !c.notes[op.id]) throw new Refused('no note ' + op.id);
    delete c.notes[op.id];
  } else throw new Refused('unknown op ' + op.op);
}

// Who signs comments: git config user.name in the project's folder, else the user's login.
function nameIn(dir) {
  let me = '';
  try { me = execFileSync('git', ['config', 'user.name'], { cwd: dir, encoding: 'utf8' }).trim(); } catch { /* no git */ }
  return me || os.userInfo().username;
}

// A thread is pinned to a board (board, bx, by: from the board's top left) or to the canvas (page, x, y); a board's
// thread with no bx is about the whole board. `author` signs what the edit writes.
export function applyComments(store, op, author) {
  const myName = () => author;
  const thread = (id) => { const t = store.threads.find((x) => x.id === id); if (!t) throw new Refused('no thread ' + id); return t; };
  const message = (t, id) => { const m = t.messages.find((x) => x.id === id); if (!m) throw new Refused('no message ' + id); return m; };
  const at = new Date().toISOString();
  if (op.op === 'add') {
    if (!ID.test(op.id || '') || store.threads.some((t) => t.id === op.id)) throw new Refused('a new thread needs a new id');
    const t = { id: op.id, resolved: false };
    if (op.board) {
      t.board = text(op.board, 200, 'board');
      if (op.bx != null) { t.bx = num(op.bx, -1e5, 1e5, 'bx'); t.by = num(op.by, -1e5, 1e5, 'by'); }
    } else { t.page = text(op.page, 40, 'page'); t.x = num(op.x, -1e6, 1e6, 'x'); t.y = num(op.y, -1e6, 1e6, 'y'); }
    t.messages = [{ id: 'm' + Date.now().toString(36), author: myName(), at, text: text(op.text, 10000, 'text') }];
    store.threads.push(t);
  } else if (op.op === 'reply') {
    thread(op.thread).messages.push({ id: 'm' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), author: myName(), at, text: text(op.text, 10000, 'text') });
  } else if (op.op === 'resolve') {
    const t = thread(op.thread);
    t.resolved = !!op.resolved;
    if (t.resolved) { t.resolvedBy = myName(); t.resolvedAt = at; } else { delete t.resolvedBy; delete t.resolvedAt; }
  } else if (op.op === 'edit') {
    const m = message(thread(op.thread), op.message);
    m.text = text(op.text, 10000, 'text');
    m.edited = at;
  } else if (op.op === 'delete') {
    const t = thread(op.thread);
    t.messages = t.messages.filter((m) => m.id !== op.message);
    if (!t.messages.length) store.threads = store.threads.filter((x) => x !== t);
  } else if (op.op === 'delete-thread') {
    thread(op.thread);
    store.threads = store.threads.filter((t) => t.id !== op.thread);
  } else throw new Refused('unknown op ' + op.op);
}

// ---- Requests ------------------------------------------------------------------------------------------------------------

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res, status, value) => send(res, status, TYPES['.json'], JSON.stringify(value));

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new Refused('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Refused('not JSON')); } });
    req.on('error', reject);
  });
}

// ---- One project's server ----------------------------------------------------------------------------------------------

// The server's state for one config: its build, its event streams, and the files it wrote. Returns { handle, watch,
// rebuild, describeSystem, close }; start() serves it.
export function createApp(CFG, { fonts = process.env.FONTS !== 'google' } = {}) {
  const CANVAS_DIR = CFG.canvas.dir;
  const CANVAS = path.join(CANVAS_DIR, 'canvas.json');
  const COMMENTS = CFG.comments;
  const SYSTEM = CFG.system;
  const LOCAL_FONTS = fonts && !!CFG.fonts;
  const known = new Map();   // a file's path → the hash of what is on disk, so the watcher tells our own writes apart
  let me = null;
  const myName = () => me || (me = nameIn(CFG.root));

  // ---- The design system -------------------------------------------------------------------------------------------------

  // The last build: whether it held, when, what it refused, the files it wrote, and the bundle it made. A build that
  // fails keeps the last good bundle, so the boards and the previews carry on with it.
  let built = { ok: false, at: null, errors: SYSTEM ? ['Not built yet.'] : [], written: [], js: null, components: [], untyped: [] };
  let building = Promise.resolve();
  let version = 0;                // counts the design system's changes, so its description is worked out once per change
  let described = null;

  const rel = (f) => path.relative(CFG.root, f).split(path.sep).join('/');

  function rebuild() {
    if (!SYSTEM) return building;
    building = building.then(async () => {
      const at = new Date().toISOString();
      try {
        const r = await ds.build(CFG);
        if (r.errors.length) built = { ...built, ok: false, at, errors: r.errors, written: [] };
        else built = { ok: true, at, errors: [], written: ds.write(r).map(rel), js: r.js, components: r.components, untyped: r.untyped };
      } catch (e) {
        built = { ...built, ok: false, at, errors: [String(e.message || e)], written: [] };
      }
      version++;
      described = null;
      if (built.ok) console.log(`Built ${SYSTEM.namespace}` + (built.written.length ? ': wrote ' + built.written.join(', ') : ', nothing changed'));
      else console.log(`${SYSTEM.namespace} did not build:\n  ` + built.errors.join('\n  '));
    });
    return building;
  }

  // Which boards use each component: each x-import of <namespace>.<Name> in a board.
  function usedOn() {
    const re = new RegExp('component-from-global-scope="' + SYSTEM.namespace + '\\.(\\w+)"', 'g');
    const out = {};
    for (const f of fs.readdirSync(CANVAS_DIR).filter((n) => n.endsWith('.dc.html')).sort()) {
      for (const m of fs.readFileSync(path.join(CANVAS_DIR, f), 'utf8').matchAll(re)) (out[m[1]] = out[m[1]] || new Set()).add(f);
    }
    return out;
  }

  // What the viewer's Design system page shows: the README, every token with its value worked out (the viewer's own
  // variables share some names with the tokens, so it shows values, never var()), and each component with its group,
  // stories, docs, types and the boards it is used on.
  async function describeSystem() {
    await building;
    if (described && described.version === version) return described.value;
    const at = version;
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    const value = { namespace: SYSTEM.namespace, title: CFG.title, readme: read(path.join(SYSTEM.dir, 'README.md')), build: { ok: built.ok, at: built.at, errors: built.errors, written: built.written, untyped: built.untyped }, groups: [], tokens: [], components: [] };
    try {
      const tokens = ds.readTokens(path.join(SYSTEM.dir, 'tokens.json'));
      value.title = tokens.name || CFG.title;
      value.groups = Object.entries(tokens.doc).filter(([k, g]) => !k.startsWith('$') && g && typeof g === 'object').map(([key, g]) => ({ key, type: g.$type || null, description: g.$description || '' }));
      value.tokens = tokens.list.map((t) => {
        const r = ds.resolve(tokens, t.value);
        const alias = typeof t.value === 'string' && /^\{([^{}]+)\}$/.test(t.value) ? tokens.byPath.get(t.value.slice(1, -1)).key : null;
        const css = t.type === 'typography'
          ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'fontFamily' ? [].concat(v).map((f) => (/\s/.test(f) ? '"' + f + '"' : f)).join(', ') : String(v)]))
          : ds.literal(tokens, t);
        return { path: t.path, key: t.key, type: t.type, group: t.group, description: t.description, sample: t.sample || null, alias, value: css };
      });
    } catch (e) {
      value.tokenError = String(e.message || e);
    }
    const stories = built.js ? await ds.loadStories(SYSTEM, built.js, String(at)) : [];
    const used = usedOn();
    const boards = readJson(CANVAS, {}).boards || {};
    const order = [...built.components, ...stories.map((x) => x.name).filter((n) => !built.components.includes(n))];
    for (const name of order) {
      const st = stories.find((x) => x.name === name) || { meta: {}, stories: {} };
      const meta = st.meta || {}, title = String(meta.title || name), params = meta.parameters || {};
      const subs = Object.keys(meta.subcomponents || {});
      const files = new Set();
      for (const n of [name, ...subs]) for (const f of used[n] || []) files.add(f);
      const dir = path.join(SYSTEM.dir, 'components', name);
      value.components.push({
        name, group: title.includes('/') ? title.slice(0, title.lastIndexOf('/')) : 'Components', subcomponents: subs,
        stories: Object.entries(st.stories).map(([k, story]) => {
          const args = storyArgs(meta, story), controls = storyControls(meta, story, args);
          return { name: k, title: storyTitle(k, story), controls, args: Object.fromEntries(controls.map((c) => [c.name, args[c.name] === undefined ? null : args[c.name]])) };
        }),
        error: st.error || null, height: Number(params.height) || 0, wide: !!params.wide,
        readme: read(path.join(dir, 'README.md')), types: read(path.join(dir, name + '.d.ts')).replace(/^\/\/.*\n/, ''),
        usedOn: [...files].sort().map((f) => ({ file: f, title: (boards[f] && boards[f].title) || f.replace(/\.dc\.html$/, '') })),
      });
    }
    if (at === version) described = { version: at, value };
    return value;
  }

  // A page that renders one component's stories with the system as built: React, dist/bundle.js and its stylesheets,
  // the fonts, and the stories' own frame. It tells the viewer its height.
  function previewPage(name) {
    const fonts = CFG.fonts ? '<link rel="stylesheet" href="/fonts/google.css">\n' : '';
    const file = path.join(SYSTEM.dir, 'components', name, name + '.stories.js');
    const written = fs.existsSync(file) ? writtenOrder(fs.readFileSync(file, 'utf8')) : [];
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
${fonts}<link rel="stylesheet" href="/system/dist/tokens.css">
<link rel="stylesheet" href="/system/dist/bundle.css">
<link rel="stylesheet" href="/system/stories/preview.css">
<style>html, body { margin: 0; background: var(--surface, #fff); } .story-error { font: 13px/1.5 ui-monospace, monospace; color: #a11d40; padding: 16px; white-space: pre-wrap; }
.dk-story { display: contents; } .dk-story.dk-block { display: block; } .dk-block > .dk-story-name { margin-bottom: 8px; }
.dk-story-name { margin: 0; font: 600 11px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #6b7280; }</style>
<script src="/kit/vendor/react/react.production.min.js"></script>
<script src="/kit/vendor/react/react-dom.production.min.js"></script>
<script src="/system/dist/bundle.js"></script>
</head>
<body>
<div id="root"></div>
<script type="module">
import { storyNames, storyTitle, storyArgs, storyElement } from '/kit/stories.mjs';
const name = ${JSON.stringify(name)}, written = ${JSON.stringify(written)}, root = document.getElementById('root');
const tell = () => parent.postMessage({ dsPreview: name, height: Math.ceil(document.documentElement.scrollHeight) }, location.origin);
// Each story sits in the system's frame (.pv, its stories/preview.css): an object story inside a block of its own, as
// Storybook renders it, so a component keeps its own width; a function story's elements in the frame itself.
// The viewer's controls: { dsArgs: { story, args } } sets what a story's args are changed to. A story is drawn again
// only when its own args change, inside a boundary of its own, so args that break it break only it, until changed.
const changed = {}, drawn = {}, versions = {};
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? React.createElement('p', { className: 'story-error' }, this.props.story + ': ' + this.state.error.message) : this.props.children; }
}
let draw = () => {};
addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== location.origin || !e.data || !e.data.dsArgs) return;
  const k = e.data.dsArgs.story;
  changed[k] = e.data.dsArgs.args || {};
  versions[k] = (versions[k] || 0) + 1;
  delete drawn[k];
  draw();
});
try {
  const mod = await import('/system/components/' + name + '/' + name + '.stories.js');
  const meta = mod.default || {}, keys = storyNames(mod, written), reactRoot = ReactDOM.createRoot(root);
  const one = (k) => {
    if (!drawn[k]) {
      let el;
      try { el = storyElement(React, meta, mod[k], { ...storyArgs(meta, mod[k]), ...changed[k] }, k); } catch (e) { el = React.createElement('p', { className: 'story-error' }, k + ': ' + e.message); }
      drawn[k] = React.createElement('div', { key: k, className: 'dk-story' + (typeof mod[k] === 'function' ? '' : ' dk-block'), 'data-story': k },
        keys.length > 1 ? React.createElement('p', { className: 'dk-story-name' }, storyTitle(k, mod[k])) : null,
        React.createElement(Boundary, { key: versions[k] || 0, story: k }, el));
    }
    return drawn[k];
  };
  draw = () => reactRoot.render(React.createElement('div', { className: 'pv' }, keys.map(one)));
  draw();
} catch (e) {
  root.className = 'story-error'; root.textContent = 'This story did not load: ' + e.message;
}
new ResizeObserver(tell).observe(document.documentElement);
setTimeout(tell, 50);
</script>
</body>
</html>
`;
  }

  // ---- Events ------------------------------------------------------------------------------------------------------------

  const listeners = new Set();
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(msg);
  }

  // What is on disk as the watch begins, so an event is a change only when a file's content differs from it. (macOS
  // reports writes made just before a watch began, and the watched folder itself by its own name.)
  function note(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(\.|node_modules$|dist$)/.test(e.name)) note(f); } else if (e.isFile() && !known.has(f)) known.set(f, hash(fs.readFileSync(f)));
    }
  }

  function watch() {
    const timers = new Map();
    // A file that changed: its content is not what was known; a path never known and still not there is no change.
    const seen = (file, run) => {
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(() => {
        timers.delete(file);
        let body = null;
        try { if (fs.statSync(file).isDirectory()) return; body = fs.readFileSync(file); } catch { /* gone */ }
        const h = body ? hash(body) : null;
        if ((known.has(file) ? known.get(file) : null) === h) return;
        known.set(file, h);
        run(body);
      }, 80));
    };
    const watchers = [];
    const on = (dir, fn) => {
      note(dir);
      try { watchers.push(fs.watch(dir, { recursive: true }, (_, name) => { if (name && !/\.tmp-\d+$/.test(name)) fn(String(name)); })); } catch { /* no such folder */ }
    };
    on(CANVAS_DIR, (name) => {
      const file = path.join(CANVAS_DIR, name);
      if (name === 'canvas.json') seen(file, (body) => { try { broadcast('canvas', { canvas: JSON.parse(body) }); } catch { /* mid-write */ } });
      else seen(file, () => broadcast('file', { path: name.split(path.sep).join('/') }));
    });
    on(path.join(KIT, 'runtime'), (name) => seen(path.join(KIT, 'runtime', name), () => broadcast('file', { path: 'support.js' })));
    on(path.join(KIT, 'viewer'), (name) => seen(path.join(KIT, 'viewer', name), () => broadcast('viewer', {})));
    fs.mkdirSync(path.dirname(COMMENTS), { recursive: true });
    if (fs.existsSync(COMMENTS) && !known.has(COMMENTS)) known.set(COMMENTS, hash(fs.readFileSync(COMMENTS)));
    watchers.push(fs.watch(path.dirname(COMMENTS), (_, name) => {
      if (name === path.basename(COMMENTS)) seen(COMMENTS, (body) => { try { broadcast('comments', { comments: JSON.parse(body) }); } catch { /* mid-write */ } });
    }));
    // The design system's source: rebuilt once the changes stop (what it installs reaches the boards as `file`), then
    // `system`. Its dist/ is the build's own output.
    if (SYSTEM) {
      let again = 0;
      on(SYSTEM.dir, (name) => {
        if (name === 'dist' || name.startsWith('dist' + path.sep) || /(^|\/)\.|~$/.test(name)) return;
        seen(path.join(SYSTEM.dir, name), () => {
          clearTimeout(again);
          again = setTimeout(() => rebuild().then(() => broadcast('system', { version, ok: built.ok, errors: built.errors })), 120);
        });
      });
    }
    return () => watchers.forEach((w) => w.close());
  }

  async function api(req, res, name) {
    const key = req.method + ' ' + name;
    if (key === 'GET events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      listeners.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); listeners.delete(res); });
      return;
    }
    if (key === 'GET me') return json(res, 200, { name: myName() });
    if (key === 'GET config') return json(res, 200, { title: CFG.title, system: SYSTEM ? SYSTEM.namespace : null });
    if (key === 'GET canvas') return json(res, 200, readJson(CANVAS, {}));
    if (key === 'GET comments') return json(res, 200, readJson(COMMENTS, { v: 1, threads: [] }));
    if (key === 'GET system') return SYSTEM ? json(res, 200, await describeSystem()) : json(res, 404, { error: 'This project has no design system.' });
    if (key === 'POST canvas' || key === 'POST comments') {
      const { ops, client } = await body(req);
      if (!Array.isArray(ops) || !ops.length) throw new Refused('ops is a list of edits');
      const isCanvas = name === 'canvas';
      const file = isCanvas ? CANVAS : COMMENTS;
      const value = readJson(file, isCanvas ? {} : { v: 1, threads: [] });
      // All the edits or none: they are made on a copy and written only if each one holds.
      const next = structuredClone(value);
      for (const op of ops) { if (isCanvas) applyCanvas(next, op); else applyComments(next, op, myName()); }
      writeJson(file, next, known);
      broadcast(name, { [isCanvas ? 'canvas' : 'comments']: next, by: client || null });
      return json(res, 200, next);
    }
    return json(res, 404, { error: 'no such call' });
  }

  // A file under base; `fonts` serves a Google Fonts address in it as /fonts/google.css.
  function serveFile(res, base, p, fonts) {
    const abs = base && path.resolve(base, '.' + path.sep + p);
    if (!base || !abs.startsWith(base + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'text/plain', 'Not found');
    const ext = path.extname(abs);
    let out = fs.readFileSync(abs);
    if (fonts && LOCAL_FONTS && (ext === '.html' || ext === '.css')) out = out.toString('utf8').replace(GOOGLE_FONTS, '/fonts/google.css');
    send(res, 200, TYPES[ext] || 'application/octet-stream', out);
  }

  // A path's prefix → the folder it serves, and whether a Google Fonts address in it is served from /fonts/.
  const ROUTES = [
    ['/viewer/', () => path.join(KIT, 'viewer')],
    ['/kit/vendor/', () => path.join(KIT, 'vendor')],
    ['/canvas/', () => CANVAS_DIR, true],
    ['/fonts/', () => CFG.fonts],
    ['/system/', () => SYSTEM && SYSTEM.dir],
  ];

  async function handle(req, res) {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return send(res, 400, 'text/plain', 'Bad path'); }
    try {
      if (p.startsWith('/api/')) return await api(req, res, p.slice(5));
      if (p === '/canvas/support.js') {
        return send(res, 200, TYPES['.js'], RUNTIME.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(KIT, f), 'utf8')).join('\n;\n'));
      }
      if (p === '/' || p === '/index.html') p = '/viewer/index.html';
      if (p === '/kit/stories.mjs') return send(res, 200, TYPES['.mjs'], fs.readFileSync(path.join(KIT, 'lib/stories.mjs')));
      if (p === '/system/preview') {
        const name = new URL(req.url, 'http://localhost').searchParams.get('c') || '';
        if (!SYSTEM || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) return send(res, 404, 'text/plain', 'Not found');
        await building;
        return send(res, 200, TYPES['.html'], previewPage(name));
      }
      const route = ROUTES.find(([prefix]) => p.startsWith(prefix));
      if (!route) return send(res, 404, 'text/plain', 'Not found');
      return serveFile(res, route[1](), p.slice(route[0].length), route[2]);
    } catch (e) {
      if (e instanceof Refused) return json(res, 400, { error: e.message });
      console.error(e);
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  return { handle, watch, rebuild, describeSystem, broadcast, listeners, rel, get built() { return built; }, LOCAL_FONTS };
}

// Starts the server for a config (loadConfig); port 0 takes any free port. Resolves to { server, url, app } once it
// listens and the design system's first build is done, so the boards it serves find the system installed.
export async function start({ config, port = 4400, fonts } = {}) {
  if (!config) throw new Error('start({ config }): the project\'s loadConfig()');
  const app = createApp(config, fonts === undefined ? {} : { fonts });
  const server = http.createServer(app.handle);
  const first = app.rebuild();
  const unwatch = app.watch();
  // The event streams never end on their own, so closing ends them first.
  const close = server.close.bind(server);
  server.close = (done) => { unwatch(); for (const r of app.listeners) r.end(); app.listeners.clear(); server.closeAllConnections(); return close(done); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (e) { unwatch(); throw e; }
  await first;
  return { server, app, url: `http://127.0.0.1:${server.address().port}/` };
}

// `design-kit serve`: starts it and says where.
export async function serve(config, port = Number(process.env.PORT || 4400)) {
  const { url, app } = await start({ config, port });
  const first = (readJson(path.join(config.canvas.dir, 'canvas.json'), {}).order || [])[0];
  console.log(`Design canvas (${app.rel(config.file)}): ${url}` + (first ? `\nA board on its own: ${url}canvas/${first}` : '') +
    (config.system ? `\nDesign system: ${url}#system` : '') + '\n' +
    (app.LOCAL_FONTS ? 'Fonts: local (' + app.rel(config.fonts) + ')' : 'Fonts: Google Fonts') + '\nCtrl+C stops it.');
}
