/*
 * The canvas viewer. It reads canvas/canvas.json through the server and lays a page of it out as the Design canvas
 * does: each board live in its own frame at its x, y, w and h, the notes beside them, on a wall that pans and zooms.
 *
 * - Edits: a board moves by its title and resizes by its corner, and is renamed with a double-click; a sticky note is
 *   added, moved, widened, written (double-click), recoloured and deleted. Each edit is saved to canvas.json at once,
 *   and ⌘Z / ⌘⇧Z undo and redo them.
 * - Comments: pinned to a spot on a board or the canvas, or about a whole board; kept in design/comments.json.
 * - A board opens full window with its tweaks and comments, and plays alone in the browser window; a link in a board
 *   opens the board it names.
 * - Whatever changes on disk (a board, the design system, canvas.json, comments.json) reaches every open viewer.
 *
 * The boards talk to it by postMessage (runtime/board.js): `ready` (with the board's tweaks), `navigate`, `wheel`
 * (on the wall only) and `error`; it sends them `tweaks`.
 *
 * The Design system page (system.js) sits beside the canvas's pages, when the project has a design system.
 *
 * URL: #page=<page id>, #board=<file>, #play=<file> or #system[=tokens|<Name>], so each can be linked to and Back works.
 */
(async function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CLIENT = Math.random().toString(36).slice(2, 10);
  var SNAP = 10;
  var FILLS = ['gray', 'red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink'];
  var SIZES = { s: 14, m: 18, l: 24, xl: 32, xxl: 48 };

  function api(method, name, body) {
    return fetch('/api/' + name, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (v) { if (!r.ok) throw new Error(v.error || r.statusText); return v; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function snap(v) { return Math.round(v / SNAP) * SNAP; }
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function when(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function typing(t) { return t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable); }

  var canvas = await api('GET', 'canvas');
  var comments = await api('GET', 'comments');
  var me = (await api('GET', 'me')).name;
  var config = await api('GET', 'config');

  // ---- The canvas, as the viewer reads it -----------------------------------------------------------------------------

  var PAGES, FIRST, BOARDS, BY_FILE, NOTES, BY_NOTE;
  function derive() {
    PAGES = canvas.pages && canvas.pages.length ? canvas.pages : [{ id: 'canvas', name: 'Canvas' }];
    FIRST = PAGES[0].id;
    var files = (canvas.order || []).filter(function (f) { return canvas.boards && canvas.boards[f]; });
    Object.keys(canvas.boards || {}).forEach(function (f) { if (files.indexOf(f) < 0) files.push(f); });
    BOARDS = files.map(function (f) {
      var b = canvas.boards[f];
      return Object.assign({ x: 0, y: 0, w: 1440, h: 900 }, b, { file: f, title: b.title || f.replace(/\.dc\.html$/, ''), page: b.page || FIRST });
    });
    BY_FILE = {};
    BOARDS.forEach(function (b) { BY_FILE[b.file] = b; });
    NOTES = Object.keys(canvas.notes || {}).map(function (id) { return Object.assign({}, canvas.notes[id], { id: id, page: canvas.notes[id].page || FIRST }); });
    BY_NOTE = {};
    NOTES.forEach(function (n) { BY_NOTE[n.id] = n; });
  }
  derive();
  function boardsOn(id) { return BOARDS.filter(function (b) { return b.page === id; }); }

  // ---- What this browser remembers --------------------------------------------------------------------------------------

  var STORE = 'dc-viewer:' + (canvas.title || 'canvas');
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { saved = {}; }
  var tweaks = saved.tweaks || {};         // file → { prop: value } that differ from the board's defaults
  var views = saved.views || {};           // page → { x, y, z }
  var widthMode = saved.width || 'fit';    // 'fit', 'board' or 'phone', in the full-window view
  var sideOpen = saved.sideOpen !== false;
  var sideTab = saved.sideTab || 'tweaks';
  var navOpen = saved.navOpen !== false;   // the sidebar; on a narrow window it lies over the canvas, and starts closed
  function remember() {
    try { localStorage.setItem(STORE, JSON.stringify({ tweaks: tweaks, views: views, width: widthMode, sideOpen: sideOpen, sideTab: sideTab, navOpen: navOpen })); } catch (e) { /* private window */ }
  }
  var rememberTimer = 0;
  function rememberSoon() { clearTimeout(rememberTimer); rememberTimer = setTimeout(remember, 400); }

  var propsDefs = {};   // file → the board's data-props, as it reported them when it started
  var errors = {};      // file → its last error
  var reloads = 0;

  var TITLE = canvas.title || config.title || 'Design canvas';
  document.title = TITLE;
  $('title').textContent = TITLE;

  // `as` is 'wall' (on the canvas), 'play' (playing) or nothing (full window, or on its own).
  function boardUrl(file, as, fresh) {
    var p = new URLSearchParams();
    if (as) p.set(as, '1');
    var t = tweaks[file];
    if (t && Object.keys(t).length) p.set('tweaks', JSON.stringify(t));
    var hash = p.toString();
    return '/canvas/' + file.split('/').map(encodeURIComponent).join('/') + (fresh ? '?v=' + fresh : '') + (hash ? '#' + hash : '');
  }

  // ---- Saving: edits to canvas.json, with undo ---------------------------------------------------------------------------

  var past = [], future = [], queue = Promise.resolve(), pending = 0, saveTimer = 0;

  function setSave(state, msg) {
    var s = $('save');
    clearTimeout(saveTimer);
    s.classList.remove('fade', 'error');
    if (state === 'saving') s.textContent = 'Saving…';
    else if (state === 'saved') { s.textContent = 'Saved'; saveTimer = setTimeout(function () { s.classList.add('fade'); }, 1200); }
    else { s.textContent = 'Not saved: ' + msg; s.classList.add('error'); }
  }

  // The same edits the server makes (serve.mjs, applyCanvas), so the wall moves before the save comes back.
  function localOp(c, op) {
    if (op.op === 'board') {
      var b = c.boards[op.file];
      Object.keys(op.set).forEach(function (k) { if (op.set[k] === null) delete b[k]; else b[k] = op.set[k]; });
    } else if (op.op === 'note') {
      var n = c.notes[op.id];
      Object.keys(op.set).forEach(function (k) { if (op.set[k] === null) delete n[k]; else n[k] = op.set[k]; });
    } else if (op.op === 'note-add') {
      c.notes = c.notes || {};
      c.notes[op.id] = JSON.parse(JSON.stringify(op.note));
    } else if (op.op === 'note-delete') delete c.notes[op.id];
  }

  function applyLocal(ops) { ops.forEach(function (op) { localOp(canvas, op); }); derive(); renderTabs(); sync(); }

  function save(ops) {
    setSave('saving');
    pending++;
    queue = queue.then(function () { return api('POST', 'canvas', { ops: ops, client: CLIENT }); })
      .then(function (next) { if (--pending === 0) { canvas = next; derive(); renderTabs(); sync(); setSave('saved'); } })
      .catch(function (e) {
        pending = Math.max(0, pending - 1);
        setSave('error', e.message);
        return api('GET', 'canvas').then(function (c) { canvas = c; derive(); renderTabs(); sync(); });
      });
  }

  function commit(redo, undo) {
    applyLocal(redo);
    past.push({ redo: redo, undo: undo });
    if (past.length > 200) past.shift();
    future = [];
    save(redo);
  }
  function undo() { var h = past.pop(); if (!h) return; applyLocal(h.undo); future.push(h); save(h.undo); }
  function redo() { var h = future.pop(); if (!h) return; applyLocal(h.redo); past.push(h); save(h.redo); }

  // ---- The sidebar: the canvas's pages, then the design system ------------------------------------------------------------

  var page = null;
  var narrow = window.matchMedia('(max-width: 760px)');
  function renderTabs() {
    var box = $('navPages');
    box.textContent = '';
    PAGES.forEach(function (pg) {
      var item = el('a', 'nav-item');
      item.href = '#page=' + encodeURIComponent(pg.id); item.dataset.page = pg.id;
      if (pg.id === page && !sysOpen) item.setAttribute('aria-current', 'page');
      item.appendChild(el('span', 'nav-label', pg.name || pg.id));
      item.appendChild(el('span', 'nav-count', String(boardsOn(pg.id).length)));
      item.title = boardsOn(pg.id).length + ' boards';
      item.addEventListener('click', function (e) { e.preventDefault(); go({ page: pg.id }); });
      box.appendChild(item);
    });
    var pg = PAGES.filter(function (p) { return p.id === page; })[0];
    $('where').textContent = sysOpen ? 'Design system · ' + DS.label(sysOpen) : pg ? pg.name || pg.id : '';
  }
  function setNav(on) {
    navOpen = on;
    document.body.classList.toggle('nav-closed', !on);
    $('navToggle').setAttribute('aria-pressed', String(on));
    if (!narrow.matches) rememberSoon();
  }
  $('navToggle').addEventListener('click', function () { setNav(!navOpen); });
  // On a narrow window the sidebar lies over the canvas: choosing from it, or a click outside it, closes it.
  $('sidebar').addEventListener('click', function (e) { if (narrow.matches && e.target.closest('a')) setNav(false); });
  document.addEventListener('pointerdown', function (e) {
    if (narrow.matches && navOpen && !e.target.closest('#sidebar, #navToggle')) setNav(false);
  }, true);
  setNav(narrow.matches ? false : navOpen);

  // ---- The design system's page --------------------------------------------------------------------------------------------

  var DS = config.system ? window.DesignSystem({
    root: $('ds'),
    control: controlFor,
    words: words,
    onSection: function (s) { go({ system: s }); },
    onBoard: function (file) { go({ board: file }); },
  }) : null;
  var sysOpen = null;
  if (DS) { $('navDsHead').hidden = false; $('navDs').hidden = false; DS.nav($('navDs')); }
  function showSystem(s) {
    sysOpen = s;
    $('stage').hidden = true; $('ds').hidden = false;
    document.body.classList.add('ds-open');
    DS.open(s).then(renderTabs);
    renderTabs();
  }
  function hideSystem() {
    if (!sysOpen) return;
    sysOpen = null;
    $('ds').hidden = true; $('stage').hidden = false;
    document.body.classList.remove('ds-open');
    document.title = TITLE;
    DS.close();
    renderTabs();
  }

  // ---- The wall ----------------------------------------------------------------------------------------------------------

  var stage = $('stage'), wall = $('wall'), labels = $('labels'), top = $('top'), shield = $('shield');
  var view = { x: 0, y: 0, z: 1 };
  var dom = { boards: new Map(), notes: new Map(), pins: new Map() };
  var selected = null;     // { kind: 'board' | 'note', id }
  var tool = 'select';     // 'select', 'hand' or 'comment'
  var editing = null;      // the note being written
  var renaming = null;     // the board being renamed

  function showPage(id) {
    if (!PAGES.some(function (p) { return p.id === id; })) id = FIRST;
    if (page === id && dom.boards.size + dom.notes.size) { sync(); return; }
    page = id;
    selected = null; closePopover();
    wall.textContent = ''; labels.textContent = ''; top.textContent = '';
    dom.boards.clear(); dom.notes.clear(); dom.pins.clear();
    renderTabs();
    sync();
    if (views[id]) { view = Object.assign({}, views[id]); apply(); } else fit();
  }

  function place(e, x, y, w, h) { e.style.left = x + 'px'; e.style.top = y + 'px'; if (w != null) e.style.width = w + 'px'; if (h != null) e.style.height = h + 'px'; }

  function makeBoard(b) {
    var d = { el: el('div', 'board'), frame: document.createElement('iframe'), label: el('div', 'label') };
    d.frame.title = b.title;
    d.frame.src = boardUrl(b.file, 'wall');
    d.el.appendChild(d.frame);
    wall.appendChild(d.el);
    d.label.dataset.file = b.file;
    d.name = el('span', 'name');
    d.name.title = 'Drag to move · double-click to rename';
    d.play = el('button', 'play');
    d.play.type = 'button';
    d.play.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>Play';
    d.play.addEventListener('click', function () { go({ play: b.file }); });
    d.open = el('button', 'open');
    d.open.type = 'button';
    d.open.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5h3v3M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5H6.5"/></svg>Open';
    d.open.addEventListener('click', function () { go({ board: b.file }); });
    d.label.appendChild(d.name); d.label.appendChild(d.play); d.label.appendChild(d.open);
    labels.appendChild(d.label);
    dom.boards.set(b.file, d);
    return d;
  }

  function noteSize(n, base) { return typeof n.size === 'number' ? n.size : SIZES[n.size] || base; }

  function renderNote(e, n) {
    var kind = n.kind || 'sticky';
    var cls = 'note';
    if (kind === 'sticky') cls += ' sticky' + (n.fill ? ' fill-' + n.fill : '');
    else if (kind === 'title1') cls += ' title1';
    else cls += ' shape';
    if (n.bold) cls += ' bold';
    if (n.italic) cls += ' italic';
    if (selected && selected.kind === 'note' && selected.id === n.id) cls += ' selected';
    if (editing === n.id) cls += ' editing';
    e.className = cls;
    e.dataset.id = n.id;
    place(e, n.x, n.y);
    if (kind === 'sticky') {
      var w = n.w || 320;
      e.style.width = w + 'px'; e.style.maxHeight = Math.round(w * 4 / 3) + 'px'; e.style.fontSize = noteSize(n, 18) + 'px';
      if (editing !== n.id && e.textContent !== (n.text || '')) e.textContent = n.text || '';
    } else if (kind === 'title1') {
      e.style.maxWidth = n.maxW ? n.maxW + 'px' : '';
      e.style.color = n.color ? 'var(--fill-' + n.color + ')' : '';
      if (editing !== n.id && e.textContent !== (n.text || '')) e.textContent = n.text || '';
      var fs = noteSize(n, 72);
      e.style.fontSize = fs + 'px';
      if (n.maxW && e.scrollWidth > n.maxW) e.style.fontSize = Math.floor(fs * n.maxW / e.scrollWidth) + 'px';
    } else {
      // Drawn on claude.ai (a rect, oval, pen line, arrow or image): kept as it is, shown only as its box.
      e.dataset.readonly = '1';
      if (n.w) e.style.width = n.w + 'px';
      if (n.h) e.style.height = n.h + 'px';
      e.textContent = 'A ' + kind + ' drawn on claude.ai';
    }
  }

  // Brings the wall in line with the canvas: boards and notes added, moved, retitled or gone.
  function sync() {
    if (!page) return;
    var want = boardsOn(page), files = new Set(want.map(function (b) { return b.file; }));
    dom.boards.forEach(function (d, file) { if (!files.has(file)) { d.el.remove(); d.label.remove(); dom.boards.delete(file); } });
    want.forEach(function (b) {
      var d = dom.boards.get(b.file) || makeBoard(b);
      d.b = b;
      place(d.el, b.x, b.y, b.w, b.h);
      if (renaming !== b.file) d.name.textContent = b.title;
      d.frame.title = b.title;
      d.play.hidden = !b.is_interactive;
      d.play.setAttribute('aria-label', 'Play ' + b.title);
      d.open.setAttribute('aria-label', 'Open ' + b.title);
      var sel = !!(selected && selected.kind === 'board' && selected.id === b.file);
      d.el.classList.toggle('selected', sel);
      d.label.classList.toggle('selected', sel);
    });
    var notes = NOTES.filter(function (n) { return n.page === page; }), ids = new Set(notes.map(function (n) { return n.id; }));
    dom.notes.forEach(function (e, id) { if (!ids.has(id)) { e.remove(); dom.notes.delete(id); } });
    notes.forEach(function (n) {
      var e = dom.notes.get(n.id);
      if (!e) { e = el('div'); wall.appendChild(e); dom.notes.set(n.id, e); }
      renderNote(e, n);
    });
    if (selected && (selected.kind === 'board' ? !files.has(selected.id) : !ids.has(selected.id))) selected = null;
    markLabels();
    syncPins();
    renderDrawer();
    renderSelection();
    apply();
  }

  function markLabels() {
    dom.boards.forEach(function (d, file) {
      var dot = d.label.querySelector('.dot'), err = d.label.querySelector('.err');
      var tweaked = tweaks[file] && Object.keys(tweaks[file]).length;
      if (tweaked && !dot) { dot = el('span', 'dot'); dot.title = 'Tweaked'; d.label.insertBefore(dot, d.label.firstChild); }
      if (!tweaked && dot) dot.remove();
      if (errors[file] && !err) { err = el('span', 'err', '!'); d.label.appendChild(err); }
      if (err) err.title = errors[file] || '';
      if (!errors[file] && err) err.remove();
    });
  }

  var queued = false;
  function apply() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      wall.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.z + ')';
      wall.style.setProperty('--z', String(view.z));
      var g = 24 * view.z * (view.z < 0.3 ? 4 : 1);
      stage.style.backgroundSize = g + 'px ' + g + 'px';
      stage.style.backgroundPosition = view.x + 'px ' + view.y + 'px';
      positionOverlay();
      $('zoomLabel').textContent = Math.round(view.z * 100) + '%';
      if (page) { views[page] = { x: view.x, y: view.y, z: view.z }; rememberSoon(); }
    });
  }
  function sx(x) { return x * view.z + view.x; }
  function sy(y) { return y * view.z + view.y; }

  function positionOverlay() {
    dom.boards.forEach(function (d) {
      d.label.style.left = sx(d.b.x) + 'px';
      d.label.style.top = (sy(d.b.y) - 28) + 'px';
      d.label.style.maxWidth = Math.max(160, d.b.w * view.z) + 'px';
    });
    positionSelection();
    positionPins();
    positionPopover();
  }

  function bounds() {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    dom.boards.forEach(function (d) { x0 = Math.min(x0, d.b.x); y0 = Math.min(y0, d.b.y - 40); x1 = Math.max(x1, d.b.x + d.b.w); y1 = Math.max(y1, d.b.y + d.b.h); });
    dom.notes.forEach(function (n) {
      x0 = Math.min(x0, n.offsetLeft); y0 = Math.min(y0, n.offsetTop);
      x1 = Math.max(x1, n.offsetLeft + n.offsetWidth); y1 = Math.max(y1, n.offsetTop + n.offsetHeight);
    });
    return x0 === Infinity ? { x0: 0, y0: 0, x1: 1440, y1: 900 } : { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function fit() {
    var r = bounds(), W = stage.clientWidth - (drawerOpen ? 330 : 0), H = stage.clientHeight, pad = 40;
    var z = Math.min((W - 2 * pad) / (r.x1 - r.x0), (H - 2 * pad) / (r.y1 - r.y0), 1);
    view = { z: z, x: (W - (r.x1 - r.x0) * z) / 2 - r.x0 * z, y: pad - r.y0 * z };
    apply();
  }
  function zoomAt(z, px, py) {
    z = Math.max(0.04, Math.min(2, z));
    view.x = px - (px - view.x) * z / view.z;
    view.y = py - (py - view.y) * z / view.z;
    view.z = z;
    apply();
  }
  function zoomBy(f) { zoomAt(view.z * f, stage.clientWidth / 2, stage.clientHeight / 2); }
  function centerOn(x, y) { view.x = (stage.clientWidth - (drawerOpen ? 330 : 0)) / 2 - x * view.z; view.y = stage.clientHeight / 2 - y * view.z; apply(); }
  function toWall(clientX, clientY) { var r = stage.getBoundingClientRect(); return { x: (clientX - r.left - view.x) / view.z, y: (clientY - r.top - view.y) / view.z }; }

  function wheel(dx, dy, mode, zoom, px, py) {
    var k = mode === 1 ? 16 : mode === 2 ? stage.clientHeight : 1;
    dx *= k; dy *= k;
    if (zoom) zoomAt(view.z * Math.exp(-Math.max(-30, Math.min(30, dy)) * 0.01), px, py);
    else { view.x -= dx; view.y -= dy; apply(); }
    hideHint();
  }

  function scrollsThatWay(e, dy) {
    for (var n = e; n && n !== stage; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY) &&
        (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return true;
    }
    return false;
  }

  stage.addEventListener('wheel', function (e) {
    var zoom = e.ctrlKey || e.metaKey;
    if (!zoom && scrollsThatWay(e.target, e.deltaY)) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    wheel(e.deltaX, e.deltaY, e.deltaMode, zoom, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ---- Dragging: moving the wall, a board, a note; resizing -----------------------------------------------------------------

  // A press becomes a drag once it moves 4px; until then it is a click, so a click and a double-click still reach
  // what was pressed. While dragging, the shield keeps the boards' frames from taking the pointer.
  function drag(e, onMove, onEnd) {
    var id = e.pointerId, x0 = e.clientX, y0 = e.clientY, moving = false;
    function move(ev) {
      if (ev.pointerId !== id) return;
      var dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moving) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moving = true;
        try { stage.setPointerCapture(id); } catch (err) { /* already released */ }
        shield.hidden = false;
        stage.classList.add('dragging');
      }
      onMove(dx, dy, ev);
    }
    function up(ev) {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      stage.classList.remove('dragging');
      shield.hidden = tool === 'select';
      onEnd(moving, ev);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function startPan(e, onClick) {
    var vx = view.x, vy = view.y;
    drag(e, function (dx, dy) { view.x = vx + dx; view.y = vy + dy; apply(); hideHint(); }, function (moved) { if (!moved && onClick) onClick(); });
  }

  function startMoveBoard(e, file) {
    var d = dom.boards.get(file), b = d.b, x0 = b.x, y0 = b.y;
    drag(e, function (dx, dy) {
      b.x = snap(x0 + dx / view.z); b.y = snap(y0 + dy / view.z);
      place(d.el, b.x, b.y); positionOverlay();
    }, function (moved) {
      if (moved && (b.x !== x0 || b.y !== y0)) commit([{ op: 'board', file: file, set: { x: b.x, y: b.y } }], [{ op: 'board', file: file, set: { x: x0, y: y0 } }]);
    });
  }

  function startResizeBoard(e, file) {
    var d = dom.boards.get(file), b = d.b, w0 = b.w, h0 = b.h;
    drag(e, function (dx, dy) {
      b.w = Math.max(120, snap(w0 + dx / view.z)); b.h = Math.max(120, snap(h0 + dy / view.z));
      place(d.el, b.x, b.y, b.w, b.h); positionOverlay();
    }, function (moved) {
      if (moved && (b.w !== w0 || b.h !== h0)) commit([{ op: 'board', file: file, set: { w: b.w, h: b.h } }], [{ op: 'board', file: file, set: { w: w0, h: h0 } }]);
    });
  }

  function startMoveNote(e, id) {
    var n = BY_NOTE[id], ne = dom.notes.get(id), x0 = n.x, y0 = n.y;
    drag(e, function (dx, dy) {
      n.x = snap(x0 + dx / view.z); n.y = snap(y0 + dy / view.z);
      place(ne, n.x, n.y); positionOverlay();
    }, function (moved) {
      if (moved && (n.x !== x0 || n.y !== y0)) commit([{ op: 'note', id: id, set: { x: n.x, y: n.y } }], [{ op: 'note', id: id, set: { x: x0, y: y0 } }]);
    });
  }

  function startWidenNote(e, id) {
    var n = BY_NOTE[id], ne = dom.notes.get(id), w0 = n.w || 320;
    drag(e, function (dx) {
      n.w = Math.max(120, snap(w0 + dx / view.z));
      ne.style.width = n.w + 'px'; ne.style.maxHeight = Math.round(n.w * 4 / 3) + 'px'; positionOverlay();
    }, function (moved) {
      if (moved && n.w !== w0) commit([{ op: 'note', id: id, set: { w: n.w } }], [{ op: 'note', id: id, set: { w: w0 } }]);
    });
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    var t = e.target;
    if (t.closest('.popover, .drawer, .note-tools, .pin, button, input, textarea, select, a')) return;
    hideHint();
    if (e.button === 1 || tool === 'hand') { startPan(e); return; }
    if (tool === 'comment') { if (t === shield) placeComment(e); return; }
    var handle = t.closest('.handle');
    if (handle) { if (handle.dataset.kind === 'board') startResizeBoard(e, selected.id); else startWidenNote(e, selected.id); return; }
    var name = t.closest('.label .name');
    if (name) { select('board', name.parentNode.dataset.file); startMoveBoard(e, name.parentNode.dataset.file); return; }
    var note = t.closest('.note');
    if (note) {
      if (note.dataset.id === editing) return;
      select('note', note.dataset.id);
      if (!note.dataset.readonly) startMoveNote(e, note.dataset.id);
      return;
    }
    startPan(e, function () { select(null); closePopover(); });
  });

  labels.addEventListener('dblclick', function (e) { var n = e.target.closest('.label .name'); if (n) startRename(n.parentNode.dataset.file); });
  wall.addEventListener('dblclick', function (e) { var n = e.target.closest('.note'); if (n && !n.dataset.readonly) startEdit(n.dataset.id); });

  // ---- Selection, renaming, writing notes ---------------------------------------------------------------------------------

  var selBits = { handle: el('div', 'handle'), tools: el('div', 'note-tools') };
  selBits.handle.title = 'Drag to resize';

  function select(kind, id) {
    selected = kind ? { kind: kind, id: id } : null;
    dom.boards.forEach(function (d, file) {
      var on = !!(selected && selected.kind === 'board' && selected.id === file);
      d.el.classList.toggle('selected', on); d.label.classList.toggle('selected', on);
    });
    dom.notes.forEach(function (n, nid) { n.classList.toggle('selected', !!(selected && selected.kind === 'note' && selected.id === nid)); });
    renderSelection();
  }

  function renderSelection() {
    selBits.handle.remove(); selBits.tools.remove();
    if (!selected || tool !== 'select') return;
    if (selected.kind === 'board') { selBits.handle.dataset.kind = 'board'; selBits.handle.className = 'handle br'; labels.appendChild(selBits.handle); }
    if (selected.kind === 'note') {
      var n = BY_NOTE[selected.id];
      if (!n || n.kind && n.kind !== 'sticky') { positionSelection(); return; }
      selBits.handle.dataset.kind = 'note'; selBits.handle.className = 'handle r'; labels.appendChild(selBits.handle);
      var tools = selBits.tools;
      tools.textContent = '';
      [null].concat(FILLS).forEach(function (f) {
        var s = el('button', 'swatch');
        s.type = 'button';
        s.style.background = 'var(--fill-' + (f || 'default') + ')';
        s.title = f ? f[0].toUpperCase() + f.slice(1) : 'Default';
        s.setAttribute('aria-label', 'Colour: ' + s.title);
        s.setAttribute('aria-pressed', String((n.fill || null) === f));
        s.addEventListener('click', function () {
          if ((n.fill || null) !== f) commit([{ op: 'note', id: n.id, set: { fill: f } }], [{ op: 'note', id: n.id, set: { fill: n.fill || null } }]);
        });
        tools.appendChild(s);
      });
      tools.appendChild(el('span', 'sep'));
      var write = el('button', 'tool text', 'Write');
      write.type = 'button';
      write.addEventListener('click', function () { startEdit(n.id); });
      var del = el('button', 'tool danger');
      del.type = 'button'; del.title = 'Delete the note (Delete)'; del.setAttribute('aria-label', 'Delete the note');
      del.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';
      del.addEventListener('click', function () { deleteNote(n.id); });
      tools.appendChild(write); tools.appendChild(del);
      labels.appendChild(tools);
    }
    positionSelection();
  }

  function positionSelection() {
    if (!selected) return;
    if (selected.kind === 'board') {
      var d = dom.boards.get(selected.id);
      if (!d) return;
      place(selBits.handle, sx(d.b.x + d.b.w), sy(d.b.y + d.b.h));
    } else {
      var ne = dom.notes.get(selected.id);
      if (!ne) return;
      var x = ne.offsetLeft, y = ne.offsetTop, w = ne.offsetWidth, h = ne.offsetHeight;
      place(selBits.handle, sx(x + w) + 4, sy(y + h / 2));
      place(selBits.tools, sx(x), Math.max(4, sy(y) - 46));
    }
  }

  function startRename(file) {
    var d = dom.boards.get(file);
    if (!d || renaming) return;
    renaming = file;
    var raw = canvas.boards[file].title || null;
    var input = document.createElement('input');
    input.value = d.b.title;
    input.setAttribute('aria-label', 'Board title');
    d.name.replaceWith(input);
    input.focus(); input.select();
    var done = false;
    function finish(keep) {
      if (done) return;
      done = true;
      renaming = null;
      input.replaceWith(d.name);
      var v = input.value.trim();
      if (keep && v && v !== d.b.title) commit([{ op: 'board', file: file, set: { title: v } }], [{ op: 'board', file: file, set: { title: raw } }]);
      else d.name.textContent = d.b.title;
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', function () { finish(true); });
  }

  function startEdit(id) {
    var ne = dom.notes.get(id), n = BY_NOTE[id];
    if (!ne || !n || editing === id) return;
    if (editing) dom.notes.get(editing) && dom.notes.get(editing).blur();
    editing = id;
    select('note', id);
    var before = n.text || '';
    ne.classList.add('editing');
    try { ne.contentEditable = 'plaintext-only'; } catch (e) { ne.contentEditable = 'true'; }
    if (ne.contentEditable !== 'plaintext-only') ne.contentEditable = 'true';
    ne.focus();
    var r = document.createRange();
    r.selectNodeContents(ne); r.collapse(false);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); ne.blur(); } e.stopPropagation(); }
    ne.addEventListener('keydown', key);
    ne.addEventListener('blur', function () {
      ne.removeEventListener('keydown', key);
      ne.contentEditable = 'false';
      ne.classList.remove('editing');
      editing = null;
      var text = ne.innerText.replace(/\n$/, '');
      if (text !== before) commit([{ op: 'note', id: id, set: { text: text } }], [{ op: 'note', id: id, set: { text: before } }]);
    }, { once: true });
  }

  function addNote() {
    if (tool !== 'select') setTool('select');
    var c = toWall(stage.getBoundingClientRect().left + stage.clientWidth / 2, stage.getBoundingClientRect().top + stage.clientHeight / 2);
    var id = newId('note-'), note = { x: snap(c.x - 180), y: snap(c.y - 120), w: 360, text: '' };
    if (canvas.pages && canvas.pages.length) note.page = page;
    commit([{ op: 'note-add', id: id, note: note }], [{ op: 'note-delete', id: id }]);
    startEdit(id);
  }

  function deleteNote(id) {
    var raw = canvas.notes && canvas.notes[id];
    if (!raw) return;
    if (selected && selected.id === id) selected = null;
    commit([{ op: 'note-delete', id: id }], [{ op: 'note-add', id: id, note: JSON.parse(JSON.stringify(raw)) }]);
  }

  // ---- Tools -------------------------------------------------------------------------------------------------------------------

  function setTool(t) {
    tool = t;
    $('hand').setAttribute('aria-pressed', String(t === 'hand'));
    $('commentTool').setAttribute('aria-pressed', String(t === 'comment'));
    shield.hidden = t === 'select';
    shield.classList.toggle('comment', t === 'comment');
    if (t !== 'select') { if (editing) dom.notes.get(editing).blur(); }
    renderSelection();
  }
  $('hand').addEventListener('click', function () { setTool(tool === 'hand' ? 'select' : 'hand'); });
  $('commentTool').addEventListener('click', function () { setTool(tool === 'comment' ? 'select' : 'comment'); });
  $('addNote').addEventListener('click', addNote);
  $('zoomIn').addEventListener('click', function () { zoomBy(1.25); });
  $('zoomOut').addEventListener('click', function () { zoomBy(0.8); });
  $('zoomLabel').addEventListener('click', function () { zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2); });
  $('fit').addEventListener('click', fit);
  window.addEventListener('resize', function () { layoutFocus(); layoutPlay(); });

  var hintTimer = setTimeout(hideHint, 8000);
  function hideHint() { clearTimeout(hintTimer); $('hint').classList.add('gone'); }

  // ---- Comments ------------------------------------------------------------------------------------------------------------------

  var popover = null;      // { id } for a thread, { id: null, at: { board, bx, by } or { page, x, y } } for a new one
  var drawerOpen = false, drawerFilter = 'open';

  // Where a thread sits on the wall: a spot on a board moves with the board; a thread about a whole board sits at its
  // top right, one beside the other.
  function threadAt(t) {
    if (t.board) {
      var b = BY_FILE[t.board];
      if (!b) return null;
      if (t.bx == null) {
        var whole = comments.threads.filter(function (x) { return x.board === t.board && x.bx == null; });
        return { page: b.page, x: b.x + b.w - 30 - whole.indexOf(t) * 32, y: b.y + 36 };
      }
      return { page: b.page, x: b.x + t.bx, y: b.y + t.by };
    }
    return { page: t.page || FIRST, x: t.x, y: t.y };
  }
  function threadsOn(pg) { return comments.threads.filter(function (t) { var a = threadAt(t); return a && a.page === pg; }); }
  function numberOf(t) { var a = threadAt(t); return a ? threadsOn(a.page).indexOf(t) + 1 : 0; }
  function whereOf(t) { return t.board ? 'On ' + (BY_FILE[t.board] ? BY_FILE[t.board].title : t.board) : 'On the canvas'; }

  function sendComments(op) {
    return api('POST', 'comments', { ops: [op], client: CLIENT })
      .then(function (next) { comments = next; commentsChanged(); return next; })
      .catch(function (e) { setSave('error', e.message); });
  }

  function commentsChanged() {
    syncPins(); renderDrawer(); renderPopover();
    if (focused && sideTab === 'comments') renderSide();
    updateCounts();
  }

  function updateCounts() {
    var open = page ? threadsOn(page).filter(function (t) { return !t.resolved; }).length : 0;
    $('commentCount').textContent = open ? String(open) : '';
    if (focused) {
      var n = comments.threads.filter(function (t) { return t.board === focused && !t.resolved; }).length;
      $('boardCount').textContent = n ? String(n) : '';
    }
  }

  function syncPins() {
    if (!page) return;
    var show = threadsOn(page).filter(function (t) { return drawerFilter !== 'open' || !t.resolved || (popover && popover.id === t.id); });
    var ids = new Set(show.map(function (t) { return t.id; }));
    dom.pins.forEach(function (p, id) { if (!ids.has(id)) { p.remove(); dom.pins.delete(id); } });
    show.forEach(function (t) {
      var p = dom.pins.get(t.id);
      if (!p) {
        p = el('button', 'pin');
        p.type = 'button';
        p.addEventListener('click', function () { openThread(t.id); });
        top.appendChild(p);
        dom.pins.set(t.id, p);
      }
      p.textContent = String(numberOf(t));
      p.classList.toggle('resolved', !!t.resolved);
      p.classList.toggle('open', !!(popover && popover.id === t.id));
      p.title = t.messages[0] ? t.messages[0].author + ': ' + t.messages[0].text.slice(0, 80) : '';
      p.setAttribute('aria-label', 'Comment ' + numberOf(t) + (t.resolved ? ', resolved' : ''));
      p.thread = t;
    });
    var draft = top.querySelector('.pin.new');
    if (draft && !(popover && !popover.id)) draft.remove();
    updateCounts();
    positionPins();
  }

  function positionPins() {
    // Worked out each time, so a pin on a board follows the board while it is dragged.
    dom.pins.forEach(function (p) { var a = p.thread && threadAt(p.thread); if (a) place(p, sx(a.x), sy(a.y) - 26); });
    var draft = top.querySelector('.pin.new');
    if (draft && popover && popover.wall) place(draft, sx(popover.wall.x), sy(popover.wall.y) - 26);
  }

  function placeComment(e) {
    var w = toWall(e.clientX, e.clientY), at = { page: page, x: Math.round(w.x), y: Math.round(w.y) };
    var hit = boardsOn(page).slice().reverse().filter(function (b) { return w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h; })[0];
    if (hit) at = { board: hit.file, bx: Math.round(w.x - hit.x), by: Math.round(w.y - hit.y) };
    closePopover();
    popover = { id: null, at: at, wall: { x: w.x, y: w.y } };
    var draft = el('div', 'pin new', '+');
    top.appendChild(draft);
    renderPopover();
    positionPins();
  }

  function openThread(id) {
    popover = { id: id };
    var t = comments.threads.filter(function (x) { return x.id === id; })[0];
    if (t && t.resolved && drawerFilter === 'open') syncPins();
    renderPopover();
    syncPins();
  }

  function closePopover() {
    if (!popover) return;
    popover = null;
    var pe = top.querySelector('.popover');
    if (pe) pe.remove();
    syncPins();
  }

  function renderPopover() {
    var pe = top.querySelector('.popover');
    if (!popover) { if (pe) pe.remove(); return; }
    if (!pe) { pe = el('div', 'popover'); pe.setAttribute('role', 'dialog'); top.appendChild(pe); }
    pe.textContent = '';
    if (!popover.id) {
      var where = popover.at.board ? 'On ' + BY_FILE[popover.at.board].title : 'On the canvas';
      pe.setAttribute('aria-label', 'New comment');
      pe.appendChild(el('div', 'thread-head', where));
      pe.appendChild(composer('Comment', 'Add a comment', function (text) {
        var op = Object.assign({ op: 'add', id: newId('t-'), text: text }, popover.at);
        return sendComments(op).then(function () { popover = { id: op.id }; syncPins(); renderPopover(); });
      }, closePopover, true));
    } else {
      var t = comments.threads.filter(function (x) { return x.id === popover.id; })[0];
      if (!t) { closePopover(); return; }
      pe.setAttribute('aria-label', 'Comment ' + numberOf(t));
      pe.appendChild(threadView(t, true));
    }
    positionPopover();
  }

  function positionPopover() {
    var pe = top.querySelector('.popover');
    if (!pe || !popover) return;
    var a = popover.id ? threadAt(comments.threads.filter(function (x) { return x.id === popover.id; })[0] || {}) : popover.wall;
    if (!a) return;
    var x = sx(a.x) + 34, y = sy(a.y) - 30, W = stage.clientWidth - (drawerOpen ? 330 : 0), H = stage.clientHeight;
    if (x + 330 > W) x = sx(a.x) - 330;
    x = Math.max(8, Math.min(x, W - 328));
    y = Math.max(8, Math.min(y, H - pe.offsetHeight - 8));
    place(pe, x, y);
  }

  // A thread: its messages, a reply box, Resolve or Reopen, and Delete (pressed twice).
  function threadView(t, inPopover) {
    var box = el('div', 'thread');
    var head = el('div', 'thread-head');
    head.appendChild(el('span', 'where', '#' + numberOf(t) + ' · ' + whereOf(t)));
    if (inPopover) {
      var x = el('button', 'tool', '×');
      x.type = 'button'; x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', closePopover);
      head.appendChild(x);
    }
    box.appendChild(head);
    t.messages.forEach(function (m) {
      var msg = el('div', 'msg');
      var mh = el('div', 'msg-head');
      mh.appendChild(el('b', null, m.author));
      mh.appendChild(el('span', null, when(m.at) + (m.edited ? ' · edited' : '')));
      if (m.author === me) {
        var del = el('button', 'del', 'Delete');
        del.type = 'button';
        del.addEventListener('click', function () { sendComments({ op: 'delete', thread: t.id, message: m.id }); });
        mh.appendChild(del);
      }
      msg.appendChild(mh);
      msg.appendChild(el('div', 'msg-text', m.text));
      box.appendChild(msg);
    });
    if (t.resolved) box.appendChild(el('div', 'resolved-note', 'Resolved' + (t.resolvedBy ? ' by ' + t.resolvedBy : '') + (t.resolvedAt ? ', ' + when(t.resolvedAt) : '')));
    else box.appendChild(composer('Reply', 'Reply', function (text) { return sendComments({ op: 'reply', thread: t.id, text: text }); }, null, inPopover));
    var actions = el('div', 'thread-actions');
    var res = el('button', 'tool text', t.resolved ? 'Reopen' : 'Resolve');
    res.type = 'button';
    res.addEventListener('click', function () { sendComments({ op: 'resolve', thread: t.id, resolved: !t.resolved }); });
    var gone = el('button', 'tool text danger', 'Delete thread');
    gone.type = 'button';
    gone.addEventListener('click', function () {
      if (gone.dataset.sure) { if (popover && popover.id === t.id) popover = null; sendComments({ op: 'delete-thread', thread: t.id }); return; }
      gone.dataset.sure = '1'; gone.textContent = 'Press again to delete';
      setTimeout(function () { delete gone.dataset.sure; gone.textContent = 'Delete thread'; }, 3000);
    });
    actions.appendChild(res); actions.appendChild(gone);
    if (!inPopover && t.bx != null) {
      var go2 = el('button', 'tool text', 'Show on canvas');
      go2.type = 'button';
      go2.addEventListener('click', function () { var a = threadAt(t); go({ page: a.page }); centerOn(a.x, a.y); openThread(t.id); });
      actions.insertBefore(go2, gone);
    }
    box.appendChild(actions);
    return box;
  }

  function composer(label, placeholder, onSend, onCancel, focus) {
    var c = el('div', 'compose');
    var ta = document.createElement('textarea');
    ta.placeholder = placeholder; ta.setAttribute('aria-label', placeholder);
    var row = el('div', 'row');
    if (onCancel) { var cancel = el('button', 'tool text', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', onCancel); row.appendChild(cancel); }
    var sendBtn = el('button', 'tool text primary', label);
    sendBtn.type = 'button'; sendBtn.disabled = true;
    function sendIt() {
      var v = ta.value.trim();
      if (!v || sendBtn.disabled) return;
      sendBtn.disabled = true;
      Promise.resolve(onSend(v)).then(function () { ta.value = ''; });
    }
    ta.addEventListener('input', function () { sendBtn.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendIt(); }
      if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
      e.stopPropagation();
    });
    sendBtn.addEventListener('click', sendIt);
    row.appendChild(sendBtn);
    c.appendChild(ta); c.appendChild(row);
    if (focus) setTimeout(function () { ta.focus(); }, 0);
    return c;
  }

  function renderDrawer() {
    var d = $('drawer');
    if (!drawerOpen || !page) return;
    d.textContent = '';
    var head = el('div', 'drawer-head');
    head.appendChild(el('h2', null, 'Comments'));
    var seg = el('div', 'seg');
    [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']].forEach(function (f) {
      var b = el('button', null, f[1]);
      b.type = 'button'; b.setAttribute('aria-pressed', String(drawerFilter === f[0]));
      b.addEventListener('click', function () { drawerFilter = f[0]; syncPins(); renderDrawer(); });
      seg.appendChild(b);
    });
    head.appendChild(seg);
    var x = el('button', 'tool', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Close comments');
    x.addEventListener('click', function () { toggleDrawer(false); });
    head.appendChild(x);
    d.appendChild(head);
    var list = threadsOn(page).filter(function (t) { return drawerFilter === 'all' || (drawerFilter === 'resolved') === !!t.resolved; });
    if (!list.length) d.appendChild(el('p', 'muted small', drawerFilter === 'open' ? 'No open comments on this page. Press C, then click the canvas or a board, to add one.' : 'None.'));
    list.forEach(function (t) {
      var item = el('button', 'item' + (t.resolved ? ' resolved' : ''));
      item.type = 'button';
      var tp = el('div', 'top');
      tp.appendChild(el('span', 'n', String(numberOf(t))));
      tp.appendChild(el('span', null, (t.messages[0] ? t.messages[0].author + ' · ' + when(t.messages[0].at) : '') + ' · ' + whereOf(t)));
      item.appendChild(tp);
      item.appendChild(el('div', 'text', t.messages[0] ? t.messages[0].text : ''));
      if (t.messages.length > 1) item.appendChild(el('div', 'muted small', (t.messages.length - 1) + (t.messages.length === 2 ? ' reply' : ' replies')));
      item.addEventListener('click', function () { var a = threadAt(t); centerOn(a.x, a.y); openThread(t.id); });
      d.appendChild(item);
    });
  }

  function toggleDrawer(on) {
    drawerOpen = on;
    $('drawer').hidden = !on;
    $('drawerToggle').setAttribute('aria-pressed', String(on));
    renderDrawer();
  }
  $('drawerToggle').addEventListener('click', function () { toggleDrawer(!drawerOpen); });

  // ---- Frames: a board full window, and playing ------------------------------------------------------------------------------

  // How a board sits in a full-window area, as on claude.ai: a page (`expand: "fill"`) fills the area and scrolls; any
  // other board is shrunk to fit. 'board' shows it at its own width, 'phone' at 390, either shrunk if the area is narrower.
  function layoutFrame(frame, wrap, area, b, mode, pad) {
    var W = area.clientWidth, H = area.clientHeight, w, h, s, top0 = 0;
    if (mode === 'phone' || mode === 'board') {
      w = mode === 'phone' ? 390 : b.w;
      s = Math.min(1, (W - 2 * pad) / w);
      h = H / s;
    } else if (b.expand === 'fill') {
      w = W - 2 * pad; s = 1; h = H;
    } else {
      w = b.w; h = b.h;
      s = Math.min(1, (W - 2 * pad) / w, (H - 2 * pad) / h);
      top0 = Math.max(0, (H - h * s) / 2);
    }
    frame.style.width = w + 'px';
    frame.style.height = Math.ceil(h) + 'px';
    frame.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    wrap.style.width = Math.floor(w * s) + 'px';
    wrap.style.height = Math.min(H, Math.ceil(h * s)) + 'px';
    wrap.style.marginLeft = -Math.floor(w * s / 2) + 'px';
    wrap.style.top = top0 + 'px';
    return s;
  }

  var focused = null, focusFrame = null;

  function openFocus(file) {
    var b = BY_FILE[file] || { file: file, x: 0, y: 0, w: 1440, h: 900, title: file.replace(/\.dc\.html$/, ''), page: page };
    var same = focused === file && focusFrame;
    focused = file;
    $('focus').hidden = false;
    $('fTitle').textContent = b.title;
    var pg = PAGES.filter(function (p) { return p.id === b.page; })[0];
    $('fPage').textContent = pg ? pg.name : '';
    var list = boardsOn(b.page), at = list.indexOf(b);
    $('fPos').textContent = at >= 0 ? (at + 1) + ' of ' + list.length : '';
    $('prev').disabled = at <= 0;
    $('next').disabled = at < 0 || at >= list.length - 1;
    $('fPlay').hidden = !b.is_interactive;
    var seg = $('fWidth');
    seg.textContent = '';
    [['fit', b.expand === 'fill' ? 'Window' : 'Fit'], ['board', 'Board · ' + b.w], ['phone', 'Phone · 390']].forEach(function (m) {
      var btn = el('button', null, m[1]);
      btn.type = 'button'; btn.setAttribute('role', 'radio'); btn.dataset.width = m[0];
      btn.addEventListener('click', function () { widthMode = m[0]; remember(); layoutFocus(); });
      seg.appendChild(btn);
    });
    if (!same) {
      $('fWrap').textContent = '';
      focusFrame = document.createElement('iframe');
      focusFrame.title = b.title;
      focusFrame.src = boardUrl(file);
      $('fWrap').appendChild(focusFrame);
    }
    $('newTab').href = boardUrl(file);
    $('side').hidden = !sideOpen;
    $('sideToggle').setAttribute('aria-pressed', String(sideOpen));
    renderSide();
    layoutFocus();
    updateCounts();
  }

  function closeFocus() {
    if (!focused) return;
    var file = focused;
    focused = null; focusFrame = null;
    $('focus').hidden = true;
    $('fWrap').textContent = '';
    var d = dom.boards.get(file);
    if (d) { d.el.classList.add('flash'); setTimeout(function () { d.el.classList.remove('flash'); }, 700); }
  }

  function layoutFocus() {
    if (!focused || !focusFrame) return;
    var b = BY_FILE[focused] || { w: 1440, h: 900 };
    var s = layoutFrame(focusFrame, $('fWrap'), $('fArea'), b, widthMode, 16);
    $('fScale').textContent = s < 1 ? Math.round(s * 100) + '%' : '';
    document.querySelectorAll('#fWidth button').forEach(function (btn) { btn.setAttribute('aria-checked', String(btn.dataset.width === widthMode)); });
  }

  $('back').addEventListener('click', function () { go({ page: BY_FILE[focused] ? BY_FILE[focused].page : page }); });
  $('prev').addEventListener('click', function () { step(focused, -1, 'board'); });
  $('next').addEventListener('click', function () { step(focused, 1, 'board'); });
  $('fPlay').addEventListener('click', function () { go({ play: focused }); });
  function step(file, d, kind) {
    var b = BY_FILE[file];
    if (!b) return;
    var list = boardsOn(b.page), at = list.indexOf(b), to = list[at + d];
    if (to) go(kind === 'play' ? { play: to.file } : { board: to.file }, true);
  }
  $('sideToggle').addEventListener('click', function () {
    sideOpen = !sideOpen; remember();
    $('side').hidden = !sideOpen;
    $('sideToggle').setAttribute('aria-pressed', String(sideOpen));
    layoutFocus();
  });
  ['tabTweaks', 'tabComments'].forEach(function (id) {
    $(id).addEventListener('click', function () { sideTab = $(id).dataset.tab; remember(); renderSide(); });
  });

  // Playing: the board alone in the whole browser window, as the app would be in a tab (a page fills it; anything
  // else is shrunk to fit). Links move to other boards in place, each with its tweaks; Esc or Exit goes back to where
  // it began.
  var playing = null, playFrame = null, playFrom = null, barTimer = 0;

  function openPlay(file) {
    var b = BY_FILE[file] || { file: file, w: 1440, h: 900, title: file, page: page, expand: 'fill' };
    if (!playing) playFrom = focused ? { board: focused } : { page: b.page };
    playing = file;
    var p = $('play');
    p.hidden = false;
    $('pTitle').textContent = b.title;
    var list = boardsOn(b.page), at = list.indexOf(b);
    $('pPrev').disabled = at <= 0;
    $('pNext').disabled = at < 0 || at >= list.length - 1;
    $('pWrap').textContent = '';
    playFrame = document.createElement('iframe');
    playFrame.title = b.title;
    playFrame.src = boardUrl(file, 'play');
    $('pWrap').appendChild(playFrame);
    layoutPlay();
    showBar();
    playFrame.focus();
  }

  function layoutPlay() { if (playing && playFrame) layoutFrame(playFrame, $('pWrap'), $('play'), BY_FILE[playing] || { w: 1440, h: 900, expand: 'fill' }, 'fit', 0); }

  function closePlay() {
    if (!playing) return;
    playing = null; playFrame = null;
    $('play').hidden = true;
    $('pWrap').textContent = '';
  }

  function stopPlaying() { var back = playFrom || { page: page || FIRST }; playFrom = null; go(back); }

  function showBar() {
    var bar = $('pBar');
    bar.classList.remove('away');
    clearTimeout(barTimer);
    barTimer = setTimeout(function () { if (!bar.matches(':hover')) bar.classList.add('away'); }, 2500);
  }
  $('pHot').addEventListener('mouseenter', showBar);
  $('pBar').addEventListener('mouseleave', showBar);
  $('pExit').addEventListener('click', stopPlaying);
  $('pPrev').addEventListener('click', function () { step(playing, -1, 'play'); });
  $('pNext').addEventListener('click', function () { step(playing, 1, 'play'); });

  // ---- Tweaks and the board's comments, beside the board ------------------------------------------------------------------------

  function words(key) {
    var s = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function valueOf(file, key) {
    var t = tweaks[file] || {}, def = propsDefs[file] || {};
    return key in t ? t[key] : def[key] && def[key].default;
  }
  function setTweak(file, key, value) {
    var def = propsDefs[file] || {}, t = tweaks[file] || (tweaks[file] = {});
    if (def[key] && value === def[key].default) delete t[key]; else t[key] = value;
    if (!Object.keys(t).length) delete tweaks[file];
    remember();
    sendTweaks(file);
  }
  function framesOf(file) {
    var out = [];
    var d = dom.boards.get(file);
    if (d) out.push(d.frame);
    if (focused === file && focusFrame) out.push(focusFrame);
    if (playing === file && playFrame) out.push(playFrame);
    return out;
  }
  function sendTweaks(file) {
    var values = tweaks[file] || {};
    framesOf(file).forEach(function (f) { if (f.contentWindow) f.contentWindow.postMessage({ dc: 'tweaks', values: values }, location.origin); });
    if (focused === file) { $('newTab').href = boardUrl(file); renderSide(); }
    markLabels();
  }

  function renderSide() {
    if (!focused) return;
    $('tabTweaks').setAttribute('aria-selected', String(sideTab === 'tweaks'));
    $('tabComments').setAttribute('aria-selected', String(sideTab === 'comments'));
    var body = $('sideBody');
    body.textContent = '';
    if (sideTab === 'comments') renderBoardComments(body); else renderTweaks(body);
  }

  function renderTweaks(panel) {
    var file = focused, def = propsDefs[file];
    var head = el('div', 'side-head');
    head.appendChild(el('span', 'muted small', 'The states this board can show. A change applies at once, here and on the canvas.'));
    var reset = el('button', 'tool text small', 'Reset');
    reset.type = 'button';
    reset.disabled = !(tweaks[file] && Object.keys(tweaks[file]).length);
    reset.addEventListener('click', function () { delete tweaks[file]; remember(); sendTweaks(file); });
    head.appendChild(reset);
    panel.appendChild(head);
    if (!def) { panel.appendChild(el('p', 'muted small', 'Loading the board…')); return; }
    var keys = Object.keys(def).filter(function (k) { return k[0] !== '$' && def[k] && typeof def[k] === 'object' && def[k].editor; });
    if (!keys.length) { panel.appendChild(el('p', 'muted small', 'This board has no tweaks.')); return; }
    var sections = [];
    keys.forEach(function (k) { var s = def[k].section || 'Tweaks'; if (sections.indexOf(s) < 0) sections.push(s); });
    sections.forEach(function (s) {
      if (sections.length > 1 || s !== 'Tweaks') panel.appendChild(el('h3', null, s));
      keys.filter(function (k) { return (def[k].section || 'Tweaks') === s; }).forEach(function (k) { panel.appendChild(control(file, k, def[k])); });
    });
  }

  function control(file, key, d) {
    return controlFor(words(key), d, valueOf(file, key), !!(tweaks[file] && key in tweaks[file]), function (v) { setTweak(file, key, v); });
  }

  // One control: a switch, a choice or a field, as a board's tweaks and the design system's story args have them. d is
  // { editor, options, min, max, step }; set(value) is given the new value.
  function controlFor(label, d, v, changed, set) {
    var wrap = el('div', 'tweak');
    if (d.editor === 'boolean') {
      var row = el('label', 'switch' + (changed ? ' changed' : ''));
      row.appendChild(el('span', null, label));
      var sw = el('button');
      sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!v)); sw.setAttribute('aria-label', label);
      sw.addEventListener('click', function () { set(!v); });
      row.appendChild(sw); wrap.appendChild(row);
      return wrap;
    }
    wrap.appendChild(el('span', 'tweak-name' + (changed ? ' changed' : ''), label));
    if (d.editor === 'enum' && Array.isArray(d.options)) {
      if (d.options.length <= 3 && d.options.join('').length <= 30) {
        var seg = el('div', 'seg');
        seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', label);
        d.options.forEach(function (o) {
          var b = el('button', null, String(o));
          b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(o === v));
          b.addEventListener('click', function () { set(o); });
          seg.appendChild(b);
        });
        wrap.appendChild(seg);
      } else {
        var sel = document.createElement('select');
        sel.setAttribute('aria-label', label);
        d.options.forEach(function (o, i) { var opt = el('option', null, String(o)); opt.value = String(i); opt.selected = o === v; sel.appendChild(opt); });
        sel.addEventListener('change', function () { set(d.options[Number(sel.value)]); });
        wrap.appendChild(sel);
      }
      return wrap;
    }
    var input = document.createElement('input');
    var numeric = /^(int|float|range|number)$/.test(d.editor);
    input.type = numeric ? 'number' : d.editor === 'color' ? 'color' : 'text';
    if (d.min != null) input.min = d.min;
    if (d.max != null) input.max = d.max;
    if (d.step != null) input.step = d.step;
    input.value = v == null ? '' : String(v);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', function () { set(numeric ? Number(input.value) : input.value); });
    wrap.appendChild(input);
    return wrap;
  }

  function renderBoardComments(panel) {
    var file = focused;
    panel.appendChild(composer('Comment', 'Comment on this board', function (text) {
      return sendComments({ op: 'add', id: newId('t-'), board: file, text: text });
    }, null, false));
    var list = comments.threads.filter(function (t) { return t.board === file; });
    var open = list.filter(function (t) { return !t.resolved; }), done = list.filter(function (t) { return t.resolved; });
    if (!list.length) panel.appendChild(el('p', 'muted small', 'No comments on this board yet. To pin one to a spot, use the comment tool on the canvas.'));
    if (open.length) { panel.appendChild(el('h3', null, 'Open')); open.forEach(function (t) { panel.appendChild(threadView(t, false)); }); }
    if (done.length) { panel.appendChild(el('h3', null, 'Resolved')); done.forEach(function (t) { panel.appendChild(threadView(t, false)); }); }
  }

  // ---- Messages from the boards ---------------------------------------------------------------------------------------------------

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.dc) return;
    var d = e.data, wallBoard = null;
    dom.boards.forEach(function (x) { if (x.frame.contentWindow === e.source) wallBoard = x; });
    var fromFocus = focusFrame && focusFrame.contentWindow === e.source;
    var fromPlay = playFrame && playFrame.contentWindow === e.source;
    if (!wallBoard && !fromFocus && !fromPlay) return;
    if (d.dc === 'ready') {
      propsDefs[d.file] = d.props || {};
      if (errors[d.file]) { delete errors[d.file]; markLabels(); }
      if (fromFocus && sideTab === 'tweaks') renderSide();
    } else if (d.dc === 'escape' && fromPlay) {
      stopPlaying();
    } else if (d.dc === 'navigate') {
      go(fromPlay ? { play: d.href } : { board: d.href });
    } else if (d.dc === 'error') {
      errors[d.file] = d.message; markLabels();
    } else if (d.dc === 'wheel' && wallBoard) {
      var fr = wallBoard.frame.getBoundingClientRect(), st = stage.getBoundingClientRect();
      wheel(d.dx, d.dy, d.mode, d.zoom, fr.left + d.x * view.z - st.left, fr.top + d.y * view.z - st.top);
    }
  });

  // ---- Changes on disk, and from other viewers -----------------------------------------------------------------------------------

  function reloadFrames(changed) {
    var all = !/\.dc\.html$/.test(changed), fresh = (++reloads).toString(36) + Date.now().toString(36);
    dom.boards.forEach(function (d, file) { if (all || file === changed) d.frame.src = boardUrl(file, 'wall', fresh); });
    if (focusFrame && (all || focused === changed)) focusFrame.src = boardUrl(focused, null, fresh);
    if (playFrame && (all || playing === changed)) playFrame.src = boardUrl(playing, 'play', fresh);
  }

  var events = new EventSource('/api/events');
  events.addEventListener('canvas', function (e) {
    var d = JSON.parse(e.data);
    if (d.by === CLIENT || pending) return;
    canvas = d.canvas; derive(); renderTabs(); sync();
    if (focused && BY_FILE[focused]) $('fTitle').textContent = BY_FILE[focused].title;
  });
  events.addEventListener('comments', function (e) {
    var d = JSON.parse(e.data);
    if (d.by === CLIENT) return;
    comments = d.comments; commentsChanged();
  });
  // A board reloads alone; anything else (the design system, the runtime) reloads every board, once for a build's files.
  var reloadAll = 0;
  events.addEventListener('file', function (e) {
    var changed = JSON.parse(e.data).path;
    if (/\.dc\.html$/.test(changed)) reloadFrames(changed);
    else { clearTimeout(reloadAll); reloadAll = setTimeout(function () { reloadFrames(changed); }, 150); }
  });
  events.addEventListener('system', function () { if (DS) DS.refresh(); });
  events.addEventListener('viewer', function () { location.reload(); });

  // ---- Keys -------------------------------------------------------------------------------------------------------------------------

  var spaceHand = false;
  document.addEventListener('keydown', function (e) {
    if (typing(e.target)) return;
    if (sysOpen) return;
    var mod = e.metaKey || e.ctrlKey;
    if (playing) { if (e.key === 'Escape') stopPlaying(); return; }
    if (focused) { if (e.key === 'Escape') go({ page: BY_FILE[focused] ? BY_FILE[focused].page : page }); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key, used = true;
    if (k === ' ') { if (!e.repeat && tool === 'select') { setTool('hand'); spaceHand = true; } }
    else if (k === 'Escape') { if (popover) closePopover(); else if (tool !== 'select') setTool('select'); else select(null); }
    else if ((k === 'Delete' || k === 'Backspace') && selected && selected.kind === 'note') deleteNote(selected.id);
    else if (k === 'Enter' && selected && selected.kind === 'note') startEdit(selected.id);
    else if (k === 'n') addNote();
    else if (k === 'c') setTool(tool === 'comment' ? 'select' : 'comment');
    else if (k === 'h') setTool(tool === 'hand' ? 'select' : 'hand');
    else if (k === 'v') setTool('select');
    else if (k === '0' || k === '!') fit();
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === '1') zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2);
    else used = false;
    // A key used here goes no further: N must not also type an "n" into the note it opens.
    if (used) e.preventDefault();
  });
  document.addEventListener('keyup', function (e) { if (e.key === ' ' && spaceHand) { spaceHand = false; setTool('select'); } });

  // ---- Where we are -------------------------------------------------------------------------------------------------------------------

  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.has('system') && DS) return { system: p.get('system') || 'overview' };
    if (p.get('play')) return { play: p.get('play') };
    if (p.get('board')) return { board: p.get('board') };
    if (p.get('page')) return { page: p.get('page') };
    var l = canvas.launch || {};
    if (l.view === 'focused' && l.file) return { board: l.file };
    return { page: l.page || FIRST };
  }

  function show(where) {
    if (where.system) { closePlay(); closeFocus(); showSystem(where.system); return; }
    hideSystem();
    var file = where.play || where.board;
    if (file) showPage(BY_FILE[file] ? BY_FILE[file].page : page || FIRST);
    if (where.play) { openPlay(where.play); return; }
    closePlay();
    if (where.board) { openFocus(where.board); return; }
    closeFocus();
    showPage(where.page);
  }

  function go(where, replace) {
    var hash = where.system ? '#system' + (where.system === 'overview' ? '' : '=' + encodeURIComponent(where.system))
      : where.play ? '#play=' + encodeURIComponent(where.play) : where.board ? '#board=' + encodeURIComponent(where.board) : '#page=' + encodeURIComponent(where.page);
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
    show(where);
  }

  window.addEventListener('popstate', function () { show(readHash()); });
  window.__viewer = { undo: undo, redo: redo, state: function () { return { page: page, focused: focused, playing: playing, system: sysOpen, tool: tool, selected: selected, past: past.length, future: future.length }; } };
  show(readHash());
})();
