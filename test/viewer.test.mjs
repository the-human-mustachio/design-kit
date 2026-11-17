// The viewer in headless Chrome, driven with the mouse and keys, on a copy of the example; what reaches disk is read
// back. The tests run in order on one page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, browser } from '../index.mjs';
import { copyExample, readJson, edit, wait, NO_CHROME } from './support.mjs';

const opts = { skip: NO_CHROME, timeout: 60000 };
let ex, server, url, b;
const cleanups = [];

before(async () => {
  if (NO_CHROME) return;
  ex = copyExample({ after: (fn) => cleanups.push(fn) });
  ({ server, url } = await start({ config: ex.config, port: 0 }));
  b = await browser();
});
after(async () => {
  if (b) await b.close();
  if (server) await new Promise((r) => server.close(r));
  for (const fn of cleanups) fn();
});

const ev = (expr) => b.evaluate(expr);
async function until(expr, ms = 8000) {
  let last;
  for (let i = 0; i < ms / 100; i++) { last = await ev(expr).catch((e) => e.message); if (last === true || (last && last !== false && typeof last !== 'string')) return last; await wait(100); }
  throw new Error(`timed out: ${expr} (last: ${JSON.stringify(last)})`);
}
async function go(hash) { await b.send('Page.navigate', { url: url + hash }); await until('!!(window.__viewer && document.querySelector("#navPages .nav-item"))'); }
// The middle of an element on a page that scrolls (the Design system page), brought into view first.
const shown = (sel, text) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${JSON.stringify(text || null)} === null || x.textContent === ${JSON.stringify(text || '')}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const center = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const mouse = (type, x, y, extra = {}) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
async function click(at, count = 1) { assert.ok(at, 'nothing to click'); const [x, y] = at; for (let c = 1; c <= count; c++) { await mouse('mousePressed', x, y, { clickCount: c }); await mouse('mouseReleased', x, y, { clickCount: c }); } await wait(250); }
async function drag(at, dx, dy) { const [x, y] = at; await mouse('mousePressed', x, y); for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', x + dx * i / 8, y + dy * i / 8); await wait(16); } await mouse('mouseReleased', x + dx, y + dy); await wait(500); }
const CODES = { Enter: 13, Escape: 27, Delete: 46 };
async function key(k, code, modifiers = 0, text) { await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, text, windowsVirtualKeyCode: CODES[k] || 0 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers }); await wait(300); }
const type = async (text) => { await b.send('Input.insertText', { text }); await wait(150); };
const CTRL = 2, SHIFT = 8;
// A point on the canvas's background, away from the boards and notes.
const empty = () => ev(`(() => { for (let y = 860; y > 100; y -= 40) for (let x = 1400; x > 300; x -= 40) { const e = document.elementFromPoint(x, y); if (e && (e.id === 'stage' || e.id === 'wall')) return [x, y]; } return null; })()`);
const canvas = () => readJson(ex.at('canvas/canvas.json'));
async function settled(read, test, ms = 4000) { let v; for (let i = 0; i < ms / 100; i++) { v = read(); if (test(v)) return v; await wait(100); } return v; }

test('the sidebar lists the pages and the design system; a page shows its boards, each playing', opts, async () => {
  await go('#page=screens');
  await until('document.querySelectorAll("#wall .board iframe").length === 2');
  assert.deepEqual(await ev('[...document.querySelectorAll("#navPages .nav-item")].map((a) => a.querySelector(".nav-label").textContent + " " + a.querySelector(".nav-count").textContent)'), ['Screens 2', 'The format 1']);
  assert.deepEqual(await ev('[...document.querySelectorAll("#navDs .nav-group")].map((g) => g.querySelector(".nav-label").textContent + " " + g.querySelector(".nav-count").textContent)'), ['Actions 1', 'Status 1', 'Layout 1']);
  assert.equal(await ev('document.getElementById("where").textContent'), 'Screens');
  await until('[...document.querySelectorAll("#wall .board iframe")].every((f) => f.contentWindow.__dc && f.contentWindow.__dc.ready)');
  await click(await center('#navPages a[data-page="format"]'));
  await until('window.__viewer.state().page === "format" && document.querySelectorAll("#wall .board iframe").length === 1');
  assert.equal(await ev('location.hash'), '#page=format');
});

test('a board moved by its title, undone and redone, renamed, all saved to canvas.json', opts, async () => {
  await go('#page=screens');
  await until('!!document.querySelector(\'.label[data-file="Task.dc.html"] .name\')');
  const was = canvas().boards['Task.dc.html'];
  await drag(await center('.label[data-file="Task.dc.html"] .name'), 160, 80);
  const moved = await settled(() => canvas().boards['Task.dc.html'], (v) => v.x !== was.x);
  assert.ok(moved.x > was.x && moved.y > was.y, JSON.stringify([was, moved]));
  await key('z', 'KeyZ', CTRL);
  assert.deepEqual(await settled(() => canvas().boards['Task.dc.html'], (v) => v.x === was.x), was);
  await key('z', 'KeyZ', CTRL | SHIFT);
  assert.equal((await settled(() => canvas().boards['Task.dc.html'], (v) => v.x === moved.x)).y, moved.y);
  await click(await center('.label[data-file="Task.dc.html"] .name'), 2);
  await until('!!document.querySelector(".label input")');
  await ev('document.querySelector(".label input").select()');
  await type('Task — renamed');
  await key('Enter', 'Enter');
  assert.equal((await settled(() => canvas().boards['Task.dc.html'], (v) => v.title !== was.title)).title, 'Task — renamed');
});

test('a sticky note: added with N, written, deleted, and back with undo', opts, async () => {
  await go('#page=format');
  await until('document.querySelectorAll("#wall .board iframe").length === 1');
  await key('n', 'KeyN', 0, 'n');
  await until('!!document.querySelector(".note.editing")');
  await type('Check the empty state copy.');
  await click(await empty());
  const notes = await settled(() => canvas().notes, (n) => Object.values(n).some((x) => x.text === 'Check the empty state copy.'));
  const id = Object.keys(notes).find((k) => notes[k].text === 'Check the empty state copy.');
  assert.ok(id, JSON.stringify(notes));
  assert.equal(notes[id].page, 'format');
  await click(await center(`.note[data-id="${id}"]`));
  await key('Delete', 'Delete');
  assert.equal((await settled(() => canvas().notes, (n) => !n[id]))[id], undefined);
  await key('z', 'KeyZ', CTRL);
  assert.equal((await settled(() => canvas().notes, (n) => !!n[id]))[id].text, 'Check the empty state copy.');
});

test('a comment pinned on a board, signed and saved', opts, async () => {
  await go('#page=screens');
  await until('[...document.querySelectorAll("#wall .board iframe")].every((f) => f.contentWindow.__dc && f.contentWindow.__dc.ready)');
  const me = (await (await fetch(url + 'api/me')).json()).name;
  await key('c', 'KeyC', 0, 'c');
  assert.equal(await ev('window.__viewer.state().tool'), 'comment');
  await click(await ev('(() => { const r = document.querySelector(\'.board iframe[title="Tasks — list"]\').getBoundingClientRect(); return [r.left + 60, r.top + 40]; })()'));
  await until('!!document.querySelector(".popover textarea")');
  await type('Should Done sort last?');
  await key('Enter', 'Enter', CTRL);
  const c = await settled(() => (fs.existsSync(ex.at('comments.json')) ? readJson(ex.at('comments.json')) : { threads: [] }), (v) => v.threads.length === 1);
  const [th] = c.threads;
  assert.deepEqual([th.board, typeof th.bx, typeof th.by, th.messages[0].author, th.messages[0].text], ['Tasks.dc.html', 'number', 'number', me, 'Should Done sort last?']);
  await until('document.querySelectorAll(".pin:not(.new)").length === 1');
  await key('Escape', 'Escape'); await key('Escape', 'Escape');
});

test('play: the board alone, its links move to other boards, Exit goes back', opts, async () => {
  await go('#board=Tasks.dc.html');
  await until('!!document.querySelector("#fWrap iframe") && document.querySelector("#fWrap iframe").contentWindow.__dc && document.querySelector("#fWrap iframe").contentWindow.__dc.ready');
  assert.equal(await ev('document.getElementById("fPlay").hidden'), false);
  // Its tweaks beside it: Show (a choice) and Empty (a switch); a change reaches the board.
  await until('document.querySelectorAll("#sideBody .tweak").length === 2');
  assert.deepEqual(await ev('[...document.querySelectorAll("#sideBody .tweak")].map((t) => t.textContent)'), ['ShowAllOpenDone', 'Empty']);
  await click(await center('#sideBody .seg button:nth-child(3)'));
  await until('[...document.querySelector("#fWrap iframe").contentDocument.querySelectorAll(".row")].map((r) => r.querySelector(".num").textContent).join() === "TASK-124,TASK-121"');
  await click(await center('#sideBody .side-head button'));
  await until('document.querySelector("#fWrap iframe").contentDocument.querySelectorAll(".row").length === 5');
  assert.deepEqual(b.log.filter((l) => !/favicon/.test(l)), []);
  await click(await center('#fPlay'));
  await until('window.__viewer.state().playing === "Tasks.dc.html"');
  // The board's own state: Mark done on the first row moves it to Done.
  await until('!!(document.querySelector("#pWrap iframe").contentWindow.__dc || {}).ready');
  const row = 'document.querySelector("#pWrap iframe").contentDocument.querySelector(".row")';
  assert.match(await ev(row + '.textContent'), /TASK-128.*Open.*Mark done/);
  await ev(row + '.querySelector("button").click()');
  await until(row + '.textContent.includes("Reopen")');
  await ev('document.querySelector("#pWrap iframe").contentDocument.querySelector("a.name").click()');
  await until('window.__viewer.state().playing === "Task.dc.html"');
  await click(await center('#pExit'));
  await until('!window.__viewer.state().playing');
});

test('live: a board edited on disk reloads on the wall, and a token change reaches the boards', opts, async () => {
  await go('#page=screens');
  const frame = 'document.querySelector(\'.board iframe[title="Task — detail"], .board iframe[title="Task — renamed"]\')';
  await until(`!!(${frame} && ${frame}.contentWindow.__dc && ${frame}.contentWindow.__dc.ready)`);
  edit(ex.at('canvas/Task.dc.html'), (s) => s.replace('Sam Rivera', 'Edited on disk'));
  await until(`!!(${frame}.contentDocument && ${frame}.contentDocument.body.innerText.includes('Edited on disk'))`);
  const accent = `${frame}.contentWindow.getComputedStyle(${frame}.contentDocument.documentElement).getPropertyValue('--accent').trim()`;
  assert.equal(await ev(accent), '#3557d4');
  edit(ex.at('system/tokens.json'), (s) => s.replace('"#3557D4"', '"#AA2255"'));
  await until(`${accent} === '#aa2255'`, 15000);
});

test('the design system page: tokens drawn from their values, a component\'s stories rendered live', opts, async () => {
  await go('#system=tokens');
  await until('document.querySelectorAll(".ds-token").length > 0');
  const described = await (await fetch(url + 'api/system')).json();
  assert.equal(described.tokens.length, 29);
  assert.equal(await ev('document.querySelectorAll(".ds-token").length'), described.tokens.length);
  assert.equal(await ev('[...document.querySelectorAll(".ds-token")].find((t) => t.querySelector(".ds-tname").textContent === "--focus").querySelector(".ds-tval").textContent'), '→ accent · #aa2255');
  await go('#system=Card');
  await until('!!document.querySelector("iframe.ds-preview")');
  const story = 'document.querySelector("iframe.ds-preview").contentDocument';
  await until(`!!(${story} && ${story}.querySelectorAll(".ex-card").length === 2)`);
  assert.deepEqual(await ev(`[...${story}.querySelectorAll(".ex-card__title")].map((h) => h.textContent)`), ['This week', 'Details']);
  assert.deepEqual(await ev(`[...${story}.querySelectorAll(".dk-story-name")].map((p) => p.textContent)`), ['Basic', 'Collapsible']);
  await ev(`${story}.querySelector(".ex-card__toggle").click()`);
  await until(`${story}.querySelector(".ex-card__toggle").textContent === "Show"`);
  assert.deepEqual(await ev('[...document.querySelectorAll(".ds-used .ds-board")].map((x) => x.textContent)'), ['What a board can do', 'Task — renamed', 'Tasks — list']);
  assert.deepEqual(b.log.filter((l) => !/favicon/.test(l)), []);
});

test('controls change a story\'s args in its preview at once, and Reset puts them back', opts, async () => {
  await go('#system=Button');
  await until('!!document.querySelector(\'.ds-cstory[data-story="Primary"]\')');
  assert.deepEqual(await ev('[...document.querySelectorAll(".ds-cstory")].map((b) => b.dataset.story + ": " + b.querySelector("h3").textContent)'), ['Primary: Primary', 'Disabled: Disabled']);
  const story = 'document.querySelector("iframe.ds-preview").contentDocument';
  const btn = `${story}.querySelector('[data-story="Primary"] .ex-btn')`;
  await until(`!!(${story} && ${btn})`);
  assert.equal(await ev(`${btn}.className`), 'ex-btn ex-btn--primary');
  assert.deepEqual(await ev(`[...${story}.querySelectorAll(".dk-story-name")].map((p) => p.textContent)`), ['Primary', 'Disabled', 'Variants']);
  const card = '.ds-cstory[data-story="Primary"]';
  await click(await shown(card + ' .seg button', 'ghost'));
  await until(`${btn}.className === 'ex-btn ex-btn--ghost'`);
  await click(await shown(card + ' .switch button'));
  await until(`${btn}.disabled === true`);
  await ev(`(() => { const i = document.querySelector('${card} input[type="text"]'); i.value = 'Send'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`${btn}.textContent === 'Send'`);
  // The other stories are as they were.
  assert.deepEqual(await ev(`[...${story}.querySelectorAll('[data-story="Disabled"] .ex-btn')].map((b) => [b.className, b.disabled, b.textContent])`), [['ex-btn ex-btn--primary', true, 'Save']]);
  assert.equal(await ev(`${story}.querySelectorAll('[data-story="Variants"] .ex-btn').length`), 4);
  assert.equal(await ev(`document.querySelector('${card} .ds-chead button').disabled`), false);
  await click(await shown(card + ' .ds-chead button'));
  await until(`${btn}.className === 'ex-btn ex-btn--primary' && !${btn}.disabled && ${btn}.textContent === 'Save'`);
  assert.equal(await ev(`document.querySelector('${card} .ds-chead button').disabled`), true);
  assert.deepEqual(b.log.filter((l) => !/favicon/.test(l)), []);
});
