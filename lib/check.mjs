// Plays every board in canvas.json in headless Chrome (`design-kit check [Board.dc.html ...]`).
//
// Each board must start with no error, resolve every hole, and link only to boards that exist. Then each of its tweaks
// is set to each option in turn (a boolean both ways), as the viewer sets them, and the board must still render with
// no error. A board that logs an error as a tweak changes but is whole once its componentDidUpdate has run is marked
// ! (it recovers after one render, as it does on the canvas); one left broken is ✗. Exits 1 on any ✗.
//
// Chrome is $CHROME, else Playwright's headless shell or Chromium (its cache on macOS or Linux), else an installed
// Google Chrome or Chromium. $CHROME_FLAGS adds to its flags (--no-sandbox where a CI runner refuses its sandbox).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { start } from './serve.mjs';

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const found = [];
  for (const cache of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean)) {
    if (!fs.existsSync(cache)) continue;
    for (const d of fs.readdirSync(cache).sort().reverse()) {
      for (const sub of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']) found.push(path.join(cache, d, sub));
    }
  }
  found.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  const hit = found.find((f) => fs.existsSync(f));
  if (!hit) throw new Error('No Chrome found: set CHROME to a Chrome or Chromium binary.');
  return hit;
}

// A small DevTools client: one page at width × height, its errors and warnings collected in `log`. Returns { open,
// evaluate, send, log, close }: open(url) waits for a board's runtime to be ready.
export async function browser({ width = 1440, height = 900, mobile = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-check-'));
  const chrome = spawn(findChrome(), ['--headless', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, ...(process.env.CHROME_FLAGS || '').split(/\s+/).filter(Boolean), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/\S+/); if (m) res(m[0]); });
    setTimeout(() => rej(new Error('Chrome gave no DevTools address: ' + buf.slice(0, 400))), 15000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((f) => f(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const log = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') log.push('error: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      log.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]);
    }
  });
  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  const open = async (url) => {
    log.length = 0;
    await S('Page.navigate', { url });
    for (let t = 0; t < 100; t++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await evaluate('!!(window.__dc && window.__dc.ready)').catch(() => false)) return true;
    }
    return false;
  };
  const close = async () => {
    ws.close();
    await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { open, evaluate, send: S, log, close };
}

// Plays the canvas's boards (all of them, or the files named); resolves to the exit code.
export async function check(config, named = []) {
const CANVAS_DIR = config.canvas.dir;
const canvas = JSON.parse(fs.readFileSync(path.join(CANVAS_DIR, 'canvas.json'), 'utf8'));
const files = named.length ? named : (canvas.order || Object.keys(canvas.boards || {})).filter((f) => canvas.boards[f]);
const { server, url } = await start({ config, port: 0 });
const b = await browser();
let failed = 0, warned = 0;
try {
  for (const file of files) {
    const problems = [], recovers = [];
    if (!(await b.open(url + 'canvas/' + file))) problems.push('did not start in 10s');
    else {
      const first = await b.evaluate(`({
        nodes: document.querySelectorAll('#dc-root *').length,
        links: [...document.querySelectorAll('#dc-root a[href]')].map((a) => a.getAttribute('href')).filter((h) => /\\.dc\\.html$/.test(h)),
        props: window.__dc.props,
      })`);
      problems.push(...b.log);
      if (first.nodes < 20) problems.push(`rendered only ${first.nodes} elements`);
      for (const href of new Set(first.links)) if (!fs.existsSync(path.join(CANVAS_DIR, href))) problems.push('links to a missing board: ' + href);
      let tried = 0;
      for (const [key, def] of Object.entries(first.props)) {
        if (key[0] === '$') continue;
        const values = def.editor === 'enum' ? def.options : def.editor === 'boolean' ? [!def.default, def.default] : [];
        for (const v of values) {
          b.log.length = 0;
          const after = await b.evaluate(`window.__dc.setTweaks(${JSON.stringify({ [key]: v })}),
            ({ nodes: document.querySelectorAll('#dc-root *').length, broken: !!document.querySelector('#dc-root .dc-error') })`);
          tried++;
          const at = `${key} = ${JSON.stringify(v)}`;
          // An error logged on the way that the board's own componentDidUpdate then cleared: the board recovers.
          if (!after.broken && after.nodes >= 20) { for (const l of b.log) recovers.push(`${at}: ${l}`); continue; }
          for (const l of b.log) problems.push(`${at}: ${l}`);
          if (after.broken) problems.push(`${at}: the board shows an error`);
          if (after.nodes < 20) problems.push(`${at}: rendered only ${after.nodes} elements`);
        }
        await b.evaluate('window.__dc.setTweaks({})');
      }
      if (!problems.length) {
        console.log(`${recovers.length ? '!' : '✓'} ${file}  (${first.nodes} elements, ${tried} tweak values)`);
        if (recovers.length) { warned++; console.log('  recovers after one render:\n  - ' + [...new Set(recovers)].join('\n  - ')); }
        continue;
      }
    }
    failed++;
    console.log(`✗ ${file}\n  - ` + [...new Set(problems)].slice(0, 20).join('\n  - '));
  }
} finally {
  await b.close();
  server.close();
}
console.log(failed ? `\n${failed} of ${files.length} boards have problems.` : `\nAll ${files.length} boards play.` +
  (warned ? ` ${warned} log an error for one render when a tweak changes, then recover (!).` : ''));
return failed ? 1 : 0;
}
