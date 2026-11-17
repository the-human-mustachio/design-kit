// What the tests share: a copy of the example project they may change, a server on it, and its event stream.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { KIT, loadConfig, start, findChrome } from '../index.mjs';

export const EXAMPLE = path.join(KIT, 'example');

// A copy of example/ in a folder of its own, without what the build writes or the viewer saved; removed after the test.
export function copyExample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-kit-'));
  const skip = new Set([path.join(EXAMPLE, 'system/dist'), path.join(EXAMPLE, 'canvas/ds'), path.join(EXAMPLE, 'comments.json'), path.join(EXAMPLE, 'sync.json')]);
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !skip.has(src) });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = () => loadConfig(path.join(dir, 'design.config.json'));
  return { dir, config: config(), reload: config, at: (p) => path.join(dir, p) };
}

// A server on a copy of the example, closed after the test.
export async function serveExample(t, opts = {}) {
  const ex = copyExample(t);
  if (opts.prepare) opts.prepare(ex);
  const s = await start({ config: ex.reload(), port: 0, fonts: opts.fonts });
  t.after(() => new Promise((r) => s.server.close(r)));
  return { ...ex, ...s };
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const edit = (f, fn) => fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));

export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// A path sent as written: fetch would settle ../ itself.
export function rawGet(url, p) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}

// /api/events as a list that fills as events come: next(type, test) resolves with the first event of that type (and
// passing the test) that has come or comes within the time.
export function events(t, url) {
  const got = [];
  const waiting = [];
  const req = http.get(url + 'api/events', (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (block.match(/^event: (.*)$/m) || [])[1];
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        if (!type) continue;
        const e = { type, data: JSON.parse(data) };
        got.push(e);
        for (const w of [...waiting]) if (w.match(e)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(e); }
      }
    });
  });
  req.on('error', () => {});
  t.after(() => req.destroy());
  const opened = new Promise((r) => req.on('response', r));
  return {
    got,
    opened,
    next(type, test = () => true, ms = 5000) {
      const match = (e) => e.type === type && test(e.data);
      const hit = got.find(match);
      if (hit) { got.splice(got.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { match: (e) => { if (!match(e)) return false; got.splice(got.indexOf(e), 1); return true; }, resolve: (e) => { clearTimeout(timer); resolve(e); } };
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`no ${type} event in ${ms} ms; had ${JSON.stringify(got.map((g) => g.type))}`)); }, ms);
        waiting.push(w);
      });
    },
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome, or why the browser tests are skipped.
export const CHROME = (() => { try { return findChrome(); } catch { return null; } })();
export const NO_CHROME = CHROME ? false : 'no Chrome found: set CHROME to run the browser tests';

// What a function prints with console.log while it runs.
export async function printed(t, fn) {
  const lines = [];
  const log = t.mock.method(console, 'log', (...a) => { lines.push(a.join(' ')); });
  const err = t.mock.method(console, 'error', (...a) => { lines.push(a.join(' ')); });
  try { return { result: await fn(), out: lines.join('\n') }; } finally { log.mock.restore(); err.mock.restore(); }
}
