// Keeps a canvas in step with its copy on claude.ai (the config's canvas.artifact), for a project that shares its canvas
// there. claude.ai has no command line, so the reading and publishing are done through Claude's Artifact tool
// (README.md → Keeping in step with claude.ai); this script does the rest:
//
//   design-kit sync status                   what changed here since the last sync
//   design-kit sync pull <dir> --version <v> bring in a copy of claude.ai's project/ folder, read at version <v>
//                                            [--theirs | --ours] settles what both sides changed
//   design-kit sync stage <dir>              put what changed here under <dir>/project/, for publishing, and print the
//                                            Artifact call's root, file_path and files
//   design-kit sync record --version <v>     after publishing: what is here is what claude.ai has at <v>
//
// The last sync is the config's sync file: the artifact, its version, each file's sha256 then, and canvas.json as it was. A pull
// compares three ways: a file changed only on one side is taken from that side; canvas.json is merged entry by entry
// (each board, each note, each other key), so a board moved here and a note added there both survive. What both sides
// changed differently stops the pull, with nothing written, unless --theirs or --ours says which wins.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The config's paths and the command's arguments, set by sync() for the command it runs.
let CANVAS, LOCK, ARTIFACT, ARGS = [];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The canvas's own files: canvas.json, each board, and the design system it installed (ds/). Not support.js, which
// is the runtime's, nor anything else claude.ai keeps beside project/.
function filesOf(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p);
      else if (p === 'canvas.json' || p.endsWith('.dc.html') || p.startsWith('ds/')) out[p] = sha(fs.readFileSync(path.join(dir, p)));
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

// A board listed with no file, or a board file not listed (claude.ai shows it anyway): worth knowing after a merge.
function mismatches() {
  const c = JSON.parse(fs.readFileSync(path.join(CANVAS, 'canvas.json'), 'utf8')), files = filesOf(CANVAS), out = [];
  for (const f of Object.keys(c.boards || {})) if (!files[f]) out.push('canvas.json lists ' + f + ', but there is no such file');
  for (const f of Object.keys(files)) if (f.endsWith('.dc.html') && !f.startsWith('ds/') && !(c.boards || {})[f]) out.push(f + ' is not in canvas.json (claude.ai shows it anyway)');
  for (const m of out) console.log('  note: ' + m);
}

const readLock = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : null);
function writeLock(version, files, canvas, artifact) {
  fs.writeFileSync(LOCK, JSON.stringify({ artifact: artifact || ARTIFACT, version, at: new Date().toISOString(), files, canvas }, null, 2) + '\n');
}

const VALUED = ['--version', '--artifact', '--config'];
function arg(name) { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : undefined; }
const flag = (name) => ARGS.includes(name);

// Equal as JSON, whatever the order of keys.
function same(a, b) { return canon(a) === canon(b); }
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// One value, three ways: whichever side changed it; a clash when both did, differently.
function pick(base, ours, theirs, name, clashes, prefer) {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  clashes.push(name);
  return prefer === 'theirs' ? theirs : ours;
}

function mergeCanvas(base, ours, theirs, prefer) {
  const clashes = [], out = {};
  base = base || {};
  for (const k of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
    if (k === 'boards' || k === 'notes') {
      const b = base[k] || {}, o = ours[k] || {}, t = theirs[k] || {}, m = {};
      for (const id of [...new Set([...Object.keys(o), ...Object.keys(t)])]) {
        const v = pick(b[id], o[id], t[id], k + '.' + id, clashes, prefer);
        if (v !== undefined) m[id] = v;
      }
      out[k] = m;
    } else if (k !== 'order') {
      const v = pick(base[k], ours[k], theirs[k], k, clashes, prefer);
      if (v !== undefined) out[k] = v;
    }
  }
  // The back-to-front order: theirs, then boards only we have; only boards that are still there.
  const boards = Object.keys(out.boards || {});
  const order = [...(theirs.order || []), ...(ours.order || [])].filter((f, i, all) => all.indexOf(f) === i && boards.includes(f));
  for (const f of boards) if (!order.includes(f)) order.push(f);
  const keys = Object.keys(out);
  const result = {};
  for (const k of keys) { result[k] = out[k]; if (k === 'boards') result.order = order; }
  if (!('order' in result)) result.order = order;
  return { canvas: result, clashes };
}

function status() {
  const lock = readLock(), here = filesOf(CANVAS);
  if (!lock) { console.log('Never synced: no sync.json. Pull a copy of claude.ai\'s project/ first.'); return; }
  const changed = [], added = [], removed = [];
  for (const [p, h] of Object.entries(here)) { if (!(p in lock.files)) added.push(p); else if (lock.files[p] !== h) changed.push(p); }
  for (const p of Object.keys(lock.files)) if (!(p in here)) removed.push(p);
  console.log(`Last synced with ${lock.artifact} at version ${lock.version} (${lock.at}).`);
  if (!changed.length && !added.length && !removed.length) { console.log('Nothing has changed here since.'); return; }
  for (const p of changed) console.log('  changed  ' + p);
  for (const p of added) console.log('  added    ' + p);
  for (const p of removed) console.log('  removed  ' + p);
  mismatches();
}

function pull(dir) {
  const version = arg('--version');
  if (!dir || !version) throw new Error('pull <dir> --version <v>: <dir> is the project/ folder read from claude.ai');
  const prefer = flag('--theirs') ? 'theirs' : flag('--ours') ? 'ours' : null;
  const lock = readLock(), base = lock ? lock.files : {};
  const ours = filesOf(CANVAS), theirs = filesOf(dir);
  if (!theirs['canvas.json']) throw new Error(dir + ' has no canvas.json: give the project/ folder');
  const take = [], drop = [], clashes = [];
  let merged = null;
  for (const p of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
    const o = ours[p], t = theirs[p], b = base[p];
    if (o === t) continue;
    if (lock && o === b) { if (t) take.push(p); else drop.push(p); continue; }
    if (lock && t === b) continue;
    if (p === 'canvas.json') {
      const m = mergeCanvas(lock && lock.canvas, JSON.parse(fs.readFileSync(path.join(CANVAS, p), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')), prefer);
      merged = m.canvas;
      clashes.push(...m.clashes.map((c) => 'canvas.json ' + c));
      continue;
    }
    if (!t && !lock) continue;                   // only here, and never synced: kept
    if (prefer === 'theirs') { if (t) take.push(p); else drop.push(p); }
    else if (prefer !== 'ours') clashes.push(p);
  }
  if (clashes.length && !prefer) {
    console.log('Both sides changed these since the last sync, so nothing was written:');
    for (const c of clashes) console.log('  ' + c);
    console.log('Run again with --theirs (claude.ai\'s win) or --ours (these win).');
    return 1;
  }
  for (const p of take) { fs.mkdirSync(path.dirname(path.join(CANVAS, p)), { recursive: true }); fs.copyFileSync(path.join(dir, p), path.join(CANVAS, p)); }
  for (const p of drop) fs.rmSync(path.join(CANVAS, p));
  if (merged) fs.writeFileSync(path.join(CANVAS, 'canvas.json'), JSON.stringify(merged, null, 2) + '\n');
  writeLock(version, theirs, JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8')), arg('--artifact') || (lock && lock.artifact));
  const kept = Object.keys(ours).filter((p) => ours[p] !== theirs[p] && !take.includes(p) && !drop.includes(p));
  console.log(`Pulled version ${version}: ${take.length} taken from claude.ai, ${drop.length} removed as claude.ai removed them` +
    (merged ? ', canvas.json merged' : '') + (clashes.length ? `, ${clashes.length} clashes settled by --${prefer}` : '') + '.');
  for (const p of take) console.log('  from claude.ai  ' + p);
  for (const p of drop) console.log('  removed         ' + p);
  for (const p of kept) console.log('  kept as here    ' + p + (p === 'canvas.json' && merged ? ' (merged)' : ''));
  if (!take.length && !drop.length && !kept.length) console.log('  Here and claude.ai were already the same.');
  mismatches();
  return 0;
}

function stage(dir) {
  if (!dir) throw new Error('stage <dir>');
  const lock = readLock(), here = filesOf(CANVAS), base = lock ? lock.files : {};
  const files = {};
  for (const [p, h] of Object.entries(here)) {
    if (base[p] === h) continue;
    fs.mkdirSync(path.dirname(path.join(dir, 'project', p)), { recursive: true });
    fs.copyFileSync(path.join(CANVAS, p), path.join(dir, 'project', p));
    files['project/' + p] = 'project/' + p;
  }
  for (const p of Object.keys(base)) if (!(p in here)) files['project/' + p] = null;
  if (!Object.keys(files).length) { console.log('Nothing to publish: nothing has changed here since the last sync.'); return; }
  const first = files['project/canvas.json'] ? 'project/canvas.json' : Object.keys(files).find((k) => files[k]);
  const call = { url: (lock && lock.artifact) || ARTIFACT, root: path.resolve(dir), file_path: first ? path.resolve(dir, first) : undefined, files };
  if (first) delete call.files[first];
  console.log(JSON.stringify(call, null, 2));
}

function record() {
  const version = arg('--version');
  if (!version) throw new Error('record --version <v>');
  const lock = readLock();
  writeLock(version, filesOf(CANVAS), JSON.parse(fs.readFileSync(path.join(CANVAS, 'canvas.json'), 'utf8')), arg('--artifact') || (lock && lock.artifact));
  console.log(`Recorded: what is here is what claude.ai has at version ${version}.`);
}

// `design-kit sync <command> …`: args are what follows `sync` on the command line, the command, its folder and its
// flags (--version <v>, --artifact <url>, --theirs, --ours). Returns the exit code.
export function sync(config, args = []) {
  CANVAS = config.canvas.dir; LOCK = config.sync; ARTIFACT = config.canvas.artifact; ARGS = args;
  const [cmd, dir] = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
  try {
    if (cmd === 'status') status();
    else if (cmd === 'pull') return pull(dir && path.resolve(dir));
    else if (cmd === 'stage') stage(dir && path.resolve(dir));
    else if (cmd === 'record') record();
    else { console.log('design-kit sync status | pull <dir> --version <v> [--theirs|--ours] | stage <dir> | record --version <v>'); return cmd ? 1 : 0; }
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
