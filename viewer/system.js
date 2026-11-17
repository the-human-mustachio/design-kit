/*
 * The Design system page: the system's README (Overview), its tokens, and each component with its stories rendered
 * live, controls for their args (the viewer's own tweak controls, handed in as opts.control), its guide, the boards it
 * is used on and its props. It reads GET /api/system (serve.mjs → describeSystem) and
 * shows each component's stories in a frame of their own (/system/preview?c=<Name>), with the system's stylesheets;
 * the page itself never loads them, as their variables share names with the viewer's. Its list (find, Overview,
 * Tokens, the components by group) is the Design system part of the viewer's sidebar. viewer.js opens it at #system,
 * #system=tokens or #system=<Name>.
 */
window.DesignSystem = function (opts) {
  'use strict';
  var root = opts.root, data = null, section = null, filter = '', loading = null;
  var $ = function (sel, at) { return (at || root).querySelector(sel); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- Markdown: headings, paragraphs, lists (nested by indent), tables, fenced code; code, bold, italic, links -------

  function inline(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) { return /^(https?:|#|\/|\.)/.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>' : t; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + esc(codes[i]) + '</code>'; });
  }
  function markdown(text, skipTitle) {
    var lines = text.replace(/\r/g, '').split('\n'), out = [], i = 0, para = [];
    function flush() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    var item = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
    function list(indent) {
      var ordered = /\d/.test(lines[i].match(item)[2]), html = [];
      while (i < lines.length) {
        var m = lines[i].match(item);
        if (!m || m[1].length < indent) break;
        if (m[1].length > indent && html.length) { html[html.length - 1] = html[html.length - 1].replace(/<\/li>$/, list(m[1].length) + '</li>'); continue; }
        var body = m[3]; i++;
        while (i < lines.length && lines[i].trim() && !item.test(lines[i]) && /^\s+/.test(lines[i])) body += ' ' + lines[i++].trim();
        html.push('<li>' + inline(body) + '</li>');
      }
      return (ordered ? '<ol>' : '<ul>') + html.join('') + (ordered ? '</ol>' : '</ul>');
    }
    while (i < lines.length) {
      var l = lines[i], h = l.match(/^(#{1,6})\s+(.*)$/);
      if (/^```/.test(l)) {
        flush(); var code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      } else if (h) {
        flush(); i++;
        if (!(skipTitle && h[1].length === 1 && !out.length)) out.push('<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>');
      } else if (item.test(l)) { flush(); out.push(list(l.match(item)[1].length)); }
      else if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flush();
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return inline(c.trim()); }); };
        var head = cells(l); i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<table><thead><tr><th>' + head.join('</th><th>') + '</th></tr></thead><tbody>' +
          rows.map(function (r) { return '<tr><td>' + r.join('</td><td>') + '</td></tr>'; }).join('') + '</tbody></table>');
      } else if (!l.trim()) { flush(); i++; }
      else { para.push(l.trim()); i++; }
    }
    flush();
    return out.join('\n');
  }

  // ---- Loading -----------------------------------------------------------------------------------------------------------

  function load() {
    loading = fetch('/api/system', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { data = d; loading = null; return d; });
    return loading;
  }
  function byName(name) { return data && data.components.filter(function (c) { return c.name === name; })[0]; }

  // ---- Its part of the viewer's sidebar: find, Overview, Tokens, and each group of components, which opens to list them --

  var navBox = null, open = {};
  function nav(box) {
    navBox = box;
    if (!data) { (loading || load()).then(function () { if (navBox === box) nav(box); }); return; }
    if (!box.querySelector('.ds-filter')) {
      var search = el('input', 'ds-filter');
      search.type = 'search'; search.placeholder = 'Find a component'; search.setAttribute('aria-label', 'Find a component');
      search.addEventListener('input', function () { filter = search.value; renderList(); });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { var first = box.querySelector('a[data-c]'); if (first) first.click(); }
        if (e.key === 'Escape') { search.value = filter = ''; renderList(); }
      });
      box.appendChild(search);
      box.appendChild(el('div', 'ds-list'));
    }
    renderList();
  }
  function link(label, target, count, cls) {
    var a = el('a', 'nav-item' + (cls ? ' ' + cls : ''));
    a.appendChild(el('span', 'nav-label', label));
    a.href = '#system' + (target === 'overview' ? '' : '=' + encodeURIComponent(target));
    if (target !== 'overview' && target !== 'tokens') a.dataset.c = target;
    if (target === section) a.setAttribute('aria-current', 'page');
    if (count != null) a.appendChild(el('span', 'nav-count', String(count)));
    a.addEventListener('click', function (e) { e.preventDefault(); opts.onSection(target); });
    return a;
  }
  var CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  function renderList() {
    if (!navBox || !data) return;
    var list = navBox.querySelector('.ds-list');
    list.textContent = '';
    var f = filter.trim().toLowerCase();
    if (!f) { list.appendChild(link('Overview', 'overview')); list.appendChild(link('Tokens', 'tokens', data.tokens.length)); }
    var current = byName(section);
    var groups = [];
    data.components.forEach(function (c) { if (groups.indexOf(c.group) < 0) groups.push(c.group); });
    groups.forEach(function (g) {
      var all = data.components.filter(function (c) { return c.group === g; });
      var mine = all.filter(function (c) { return !f || c.name.toLowerCase().indexOf(f) >= 0 || c.subcomponents.some(function (x) { return x.toLowerCase().indexOf(f) >= 0; }); });
      if (!mine.length) return;
      var shown = !!(f || open[g] || (current && current.group === g));
      var head = el('button', 'nav-item nav-group');
      head.type = 'button'; head.setAttribute('aria-expanded', String(shown));
      head.innerHTML = CHEVRON;
      head.appendChild(el('span', 'nav-label', g));
      head.appendChild(el('span', 'nav-count', String(all.length)));
      head.addEventListener('click', function () { open[g] = !shown; renderList(); });
      list.appendChild(head);
      if (!shown) return;
      var sub = el('div', 'nav-sub');
      mine.forEach(function (c) { sub.appendChild(link(c.name, c.name)); });
      list.appendChild(sub);
    });
    if (f && !list.children.length) list.appendChild(el('p', 'nav-none', 'No component matches.'));
  }

  // ---- The pages -------------------------------------------------------------------------------------------------------

  function buildBanner(main) {
    var b = data.build;
    if (b.ok && (!b.untyped || !b.untyped.length)) return;
    var box = el('div', 'ds-banner' + (b.ok ? '' : ' bad'));
    if (!b.ok) {
      box.appendChild(el('b', null, 'The design system did not build.'));
      box.appendChild(el('span', null, ' The boards and these previews show its last build that did.'));
      var ul = el('ul');
      b.errors.forEach(function (e) { ul.appendChild(el('li', null, e)); });
      box.appendChild(ul);
    } else box.appendChild(el('span', null, 'No types for ' + b.untyped.join(', ') + ' (components/<Name>/<Name>.d.ts).'));
    main.appendChild(box);
  }

  function overview(doc) {
    var used = {};
    data.components.forEach(function (c) { c.usedOn.forEach(function (b) { used[b.file] = 1; }); });
    var groups = {};
    data.components.forEach(function (c) { groups[c.group] = 1; });
    var head = el('header', 'ds-head');
    head.appendChild(el('h1', null, data.title || 'Design system'));
    head.appendChild(el('p', 'ds-sub', data.components.length + ' components in ' + Object.keys(groups).length + ' groups · ' + data.tokens.length +
      ' tokens · window.' + data.namespace + ' · used on ' + Object.keys(used).length + ' boards'));
    doc.appendChild(head);
    var body = el('div', 'ds-md');
    body.innerHTML = markdown(data.readme || '_No README.md._');
    doc.appendChild(body);
  }

  function px(v) { var m = /^(-?[\d.]+)px$/.exec(v); return m ? Number(m[1]) : null; }

  function tokens(doc) {
    var head = el('header', 'ds-head');
    head.appendChild(el('h1', null, 'Tokens'));
    head.appendChild(el('p', 'ds-sub', 'From tokens.json, in the W3C design tokens format. Each colour, shadow, size and font is the CSS variable --<name>; each type style the class .<name>.'));
    doc.appendChild(head);
    if (data.tokenError) { doc.appendChild(el('p', 'ds-error', data.tokenError)); return; }
    data.groups.forEach(function (g) {
      var mine = data.tokens.filter(function (t) { return t.group[0] === g.key; });
      if (!mine.length) return;
      var sec = el('section', 'ds-tokens');
      sec.appendChild(el('h2', null, g.key.charAt(0).toUpperCase() + g.key.slice(1)));
      if (g.description) sec.appendChild(el('p', 'ds-sub', g.description));
      var grid = el('div', 'ds-tgrid ds-t-' + (g.type || 'other'));
      var sub = null;
      mine.forEach(function (t) {
        if (t.type === 'typography' && t.group[1] !== sub) { sub = t.group[1]; grid.appendChild(el('h3', 'ds-tsub', sub)); }
        grid.appendChild(token(t, g));
      });
      sec.appendChild(grid);
      doc.appendChild(sec);
    });
  }

  function token(t, g) {
    var card = el('div', 'ds-token');
    var show = el('div', 'ds-show');
    if (t.type === 'color') { show.classList.add('color'); show.style.background = t.value; }
    else if (t.type === 'shadow') { show.classList.add('shadow'); var s = el('div'); s.style.boxShadow = t.value; show.appendChild(s); }
    else if (t.type === 'dimension') {
      var n = px(t.value);
      if (/radius/.test(g.key) && n != null) { show.classList.add('radius'); var r = el('div'); r.style.borderRadius = t.value; show.appendChild(r); }
      else if (n != null && n <= 480) { show.classList.add('bar'); var b = el('div'); b.style.width = Math.max(1, n) + 'px'; show.appendChild(b); }
      else show = null;
    } else if (t.type === 'fontFamily') { show.classList.add('face'); show.style.fontFamily = t.value; show.textContent = 'Aa Gg 0123 — The quick brown fox'; }
    else if (t.type === 'typography') {
      show.classList.add('type');
      var v = t.value;
      show.style.fontFamily = v.fontFamily; show.style.fontSize = v.fontSize; show.style.lineHeight = v.lineHeight;
      show.style.fontWeight = v.fontWeight; if (v.letterSpacing) show.style.letterSpacing = v.letterSpacing;
      if (/label/.test(t.key)) show.style.textTransform = 'uppercase';
      show.textContent = t.sample || 'The quick brown fox';
    } else show = null;
    if (show) card.appendChild(show);
    var meta = el('div', 'ds-tmeta');
    var name = el('code', 'ds-tname', (t.type === 'typography' ? '.' : '--') + t.key);
    meta.appendChild(name);
    var val = t.type === 'typography'
      ? [t.value.fontSize, t.value.lineHeight, t.value.fontWeight, t.value.letterSpacing].filter(Boolean).join(' · ') + ' · ' + t.value.fontFamily.split(',')[0].replace(/"/g, '')
      : t.value;
    var vv = el('span', 'ds-tval', t.alias ? '→ ' + t.alias + ' · ' + val : val);
    meta.appendChild(vv);
    if (t.description) meta.appendChild(el('span', 'ds-tdesc', t.description));
    card.appendChild(meta);
    return card;
  }

  function component(doc, c) {
    var head = el('header', 'ds-head');
    var h1 = el('h1', null, c.name);
    h1.appendChild(el('span', 'ds-chip', c.group));
    head.appendChild(h1);
    var bits = [];
    if (c.subcomponents.length) bits.push('With ' + c.subcomponents.join(', '));
    bits.push(c.usedOn.length ? 'Used on ' + c.usedOn.length + ' board' + (c.usedOn.length === 1 ? '' : 's') : 'On no board');
    head.appendChild(el('p', 'ds-sub', bits.join(' · ')));
    doc.appendChild(head);

    var stage = el('div', 'ds-stage');
    if (c.error) stage.appendChild(el('p', 'ds-error', c.name + '.stories.js did not load: ' + c.error));
    var frame = el('iframe', 'ds-preview');
    frame.title = c.name + ': its stories';
    frame.dataset.min = String(c.height || 120);
    frame.style.height = (c.height || 120) + 'px';
    frame.src = '/system/preview?c=' + encodeURIComponent(c.name);
    stage.appendChild(frame);
    var alone = el('a', 'ds-alone', 'Open on its own');
    alone.href = frame.src; alone.target = '_blank'; alone.rel = 'noopener';
    stage.appendChild(alone);
    doc.appendChild(stage);
    controls(doc, c, frame);

    var guide = el('section', 'ds-md');
    guide.innerHTML = markdown(c.readme || '_No README.md._', true);
    doc.appendChild(guide);

    if (c.usedOn.length) {
      var used = el('section', 'ds-used');
      used.appendChild(el('h2', null, 'Used on'));
      var row = el('div', 'ds-boards');
      c.usedOn.forEach(function (b) {
        var btn = el('button', 'ds-board', b.title);
        btn.type = 'button'; btn.title = 'Open ' + b.file;
        btn.addEventListener('click', function () { opts.onBoard(b.file); });
        row.appendChild(btn);
      });
      used.appendChild(row);
      doc.appendChild(used);
    }
    if (c.types) {
      var props = el('section', 'ds-props');
      props.appendChild(el('h2', null, 'Props'));
      var pre = el('pre'), code = el('code', null, c.types.trim());
      pre.appendChild(code);
      props.appendChild(pre);
      doc.appendChild(props);
    }
    var files = el('p', 'ds-files', 'components/' + c.name + '/: README.md, ' + c.name + '.stories.js, ' + c.name + '.d.ts');
    doc.appendChild(files);
  }

  // ---- Controls: each story's args, changed here and shown in its preview at once ----------------------------------------

  // What the controls changed, by component and story: { arg: value }. Kept while the viewer is open, through rebuilds.
  var changedArgs = {};

  function sendArgs(frame, comp, story) {
    if (frame.contentWindow) frame.contentWindow.postMessage({ dsArgs: { story: story, args: (changedArgs[comp] || {})[story] || {} } }, location.origin);
  }

  function controls(doc, c, frame) {
    var some = c.stories.filter(function (s) { return s.controls.length; });
    if (!some.length || !opts.control) return;
    var sec = el('section', 'ds-controls');
    sec.appendChild(el('h2', null, 'Controls'));
    var grid = el('div', 'ds-cgrid');
    some.forEach(function (s) { grid.appendChild(storyControls(c, s, frame)); });
    sec.appendChild(grid);
    doc.appendChild(sec);
    // A preview that loads again (the system was rebuilt) is given what was changed.
    frame.addEventListener('load', function () { Object.keys(changedArgs[c.name] || {}).forEach(function (k) { sendArgs(frame, c.name, k); }); });
  }

  function storyControls(c, s, frame) {
    var box = el('div', 'ds-cstory');
    box.dataset.story = s.name;
    var mine = changedArgs[c.name] || (changedArgs[c.name] = {});
    function draw() {
      box.textContent = '';
      var head = el('div', 'ds-chead');
      head.appendChild(el('h3', null, s.title));
      var reset = el('button', 'tool text small', 'Reset');
      reset.type = 'button'; reset.disabled = !mine[s.name];
      reset.addEventListener('click', function () { delete mine[s.name]; sendArgs(frame, c.name, s.name); draw(); });
      head.appendChild(reset);
      box.appendChild(head);
      s.controls.forEach(function (d) {
        var now = mine[s.name] || {}, has = d.name in now;
        box.appendChild(opts.control(opts.words(d.name), d, has ? now[d.name] : s.args[d.name], has, function (v) {
          var next = Object.assign({}, mine[s.name]);
          if (v === s.args[d.name]) delete next[d.name]; else next[d.name] = v;
          if (Object.keys(next).length) mine[s.name] = next; else delete mine[s.name];
          sendArgs(frame, c.name, s.name);
          draw();
        }));
      });
    }
    draw();
    return box;
  }

  function render() {
    var main = $('.ds-main'), keep = main.scrollTop, same = main.dataset.section === section;
    main.textContent = '';
    main.dataset.section = section;
    buildBanner(main);
    var doc = el('article', 'ds-doc');
    var c = byName(section);
    if (section === 'tokens') tokens(doc);
    else if (c) component(doc, c);
    else overview(doc);
    main.appendChild(doc);
    main.scrollTop = same ? keep : 0;
    renderList();
    document.title = (c ? c.name : section === 'tokens' ? 'Tokens' : 'Overview') + ' · ' + (data.title || 'Design system');
  }

  // A preview tells us its height; it is never shorter than its story asks.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.dsPreview) return;
    root.querySelectorAll('iframe.ds-preview').forEach(function (f) {
      if (f.contentWindow === e.source) f.style.height = Math.max(Number(f.dataset.min) || 0, e.data.height) + 'px';
    });
  });

  return {
    open: function (s) {
      section = s || 'overview';
      if (!document.getElementById('ds-fonts')) {
        var l = document.createElement('link');
        l.id = 'ds-fonts'; l.rel = 'stylesheet'; l.href = '/fonts/google.css';
        document.head.appendChild(l);
      }
      return (data ? Promise.resolve(data) : loading || load()).then(render);
    },
    // The source changed and was rebuilt: read it again, and reload what shows it.
    refresh: function () {
      load().then(function () { renderList(); if (section) render(); });
    },
    close: function () { section = null; renderList(); },
    nav: nav,
    // What the viewer's bar says where we are.
    label: function (s) { var c = byName(s); return c ? c.name : s === 'tokens' ? 'Tokens' : !s || s === 'overview' ? 'Overview' : s; },
  };
};
