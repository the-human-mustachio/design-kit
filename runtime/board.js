/*
 * The boards' runtime: plays one Design canvas board (a .dc.html file) in the browser.
 *
 * A board loads it as ./support.js, which serve.mjs builds from React 18 and this file, so it runs before the board's
 * body is parsed, and React is a global, as the design system's bundle expects. It reads the board as the canvas does:
 *
 *   <x-dc>       the template: {{path}} holes, <sc-if value>, <sc-for list as>, <x-import component-from-global-scope>
 *                (a component of the design system, `<namespace>.X`), <helmet> (put in the page's head), and plain HTML.
 *   <script type="text/x-dc" data-dc-script data-props>
 *                the board's logic, `class Component extends DCLogic`, and its tweaks: each a prop with an editor,
 *                options and a default.
 *
 * A hole that is a whole attribute passes its value as it is (a function, a list, true); a hole inside other text is
 * turned into text. The template sees the props and what renderVals() returns, props first.
 *
 * Inside the viewer (viewer/), the board takes its tweaks from the viewer, and hands it the links to other boards that
 * are clicked, on the canvas the wheel, so the canvas pans and zooms over it, and while playing Esc. Opened on its own,
 * links simply navigate.
 */
(function () {
  'use strict';
  var React = window.React, ReactDOM = window.ReactDOM;
  if (!React || !ReactDOM) { console.error('[dc] React did not load before the runtime.'); return; }
  var h = React.createElement, Fragment = React.Fragment;
  var FILE = decodeURIComponent(location.pathname.split('/').pop() || '');
  var HASH = new URLSearchParams(location.hash.slice(1));
  var EMBEDDED = window.parent !== window;
  var ON_WALL = EMBEDDED && HASH.get('wall') === '1';
  var PLAYING = EMBEDDED && HASH.get('play') === '1';

  // Until the board renders, its template is raw markup, so it is hidden.
  var early = document.createElement('style');
  early.textContent = 'x-dc{display:none}' + (ON_WALL ? 'html{overflow:hidden}' : '');
  document.head.appendChild(early);

  // ---- Reading the markup ----------------------------------------------------------------------------------------

  var decoder = document.createElement('textarea');
  function decode(s) { if (s.indexOf('&') < 0) return s; decoder.innerHTML = s; return decoder.value; }

  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
  var RAW = /^(script|style|textarea|title)$/;
  var SPACE = /\s/;

  // The template as written, as a tree of { tag, attrs: [[name, value]], children } and { text }. Names keep their
  // case (onClick, viewBox), and nothing is moved the way a browser's parser moves markup it finds misplaced.
  function parse(src) {
    var lower = src.toLowerCase(), n = src.length;
    var root = { tag: '#root', lower: '#root', attrs: [], children: [] }, stack = [root], i = 0;
    function top() { return stack[stack.length - 1]; }
    function text(s) { if (s) top().children.push({ text: decode(s) }); }
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { text(src.slice(i)); break; }
      text(src.slice(i, lt));
      if (src.startsWith('<!--', lt)) { var ce = src.indexOf('-->', lt + 4); i = ce < 0 ? n : ce + 3; continue; }
      if (src[lt + 1] === '/') {
        var ge = src.indexOf('>', lt);
        if (ge < 0) break;
        var cname = lower.slice(lt + 2, ge).trim();
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].lower === cname) { stack[k].innerEnd = lt; stack.length = k; break; }
        }
        i = ge + 1;
        continue;
      }
      if (!/[A-Za-z]/.test(src[lt + 1] || '')) { text('<'); i = lt + 1; continue; }
      var j = lt + 1;
      while (j < n && !/[\s/>]/.test(src[j])) j++;
      var el = { tag: src.slice(lt + 1, j), attrs: [], children: [] };
      el.lower = el.tag.toLowerCase();
      var selfClose = false;
      while (j < n) {
        while (j < n && SPACE.test(src[j])) j++;
        if (src[j] === '>') { j++; break; }
        if (src[j] === '/') { j++; if (src[j] === '>') { selfClose = true; j++; break; } continue; }
        var a = j;
        while (j < n && !/[\s=/>]/.test(src[j])) j++;
        var name = src.slice(a, j), value = null;
        var b = j;
        while (b < n && SPACE.test(src[b])) b++;
        if (src[b] === '=') {
          j = b + 1;
          while (j < n && SPACE.test(src[j])) j++;
          var q = src[j];
          if (q === '"' || q === "'") {
            var qe = src.indexOf(q, j + 1);
            if (qe < 0) qe = n;
            value = src.slice(j + 1, qe);
            j = qe + 1;
          } else {
            var v0 = j;
            while (j < n && !/[\s>]/.test(src[j])) j++;
            value = src.slice(v0, j);
          }
        }
        if (name) el.attrs.push([name, value === null ? null : decode(value)]);
        else j++;
      }
      top().children.push(el);
      if (RAW.test(el.lower)) {
        var close = lower.indexOf('</' + el.lower, j);
        if (close < 0) close = n;
        el.children.push({ text: src.slice(j, close), raw: true });
        el.innerStart = j; el.innerEnd = close;
        var ce2 = src.indexOf('>', close);
        i = ce2 < 0 ? n : ce2 + 1;
        continue;
      }
      if (!selfClose && !VOID.test(el.lower)) { el.innerStart = j; stack.push(el); }
      i = j;
    }
    return root;
  }

  function attr(node, name) {
    for (var i = 0; i < node.attrs.length; i++) if (node.attrs[i][0].toLowerCase() === name) return node.attrs[i][1] || '';
    return null;
  }

  // ---- Holes -------------------------------------------------------------------------------------------------------

  var warned = new Set();
  function warnOnce(msg) { if (warned.has(msg)) return; warned.add(msg); console.warn('[dc] ' + FILE + ': ' + msg); }

  var IDENT = /^[A-Za-z_$][\w$]*/, KEY = /^(?:[A-Za-z_$][\w$]*|\d+)/, NUMBER = /^-?\d+(\.\d+)?$/;
  function undef() { return undefined; }

  // An expression in a hole: a path (a.b.0, a[b]), true, false, null, a number, a quoted string, !x, and x === y.
  function compileExpr(src) {
    var e = String(src).trim();
    if (!e) return undef;
    if (e[0] === '(' && e[e.length - 1] === ')' && wrapsWhole(e)) return compileExpr(e.slice(1, -1));
    var eq = findEquality(e);
    if (eq) {
      var l = compileExpr(e.slice(0, eq.at)), r = compileExpr(e.slice(eq.at + eq.op.length));
      if (eq.op === '===') return function (s) { return l(s) === r(s); };
      if (eq.op === '!==') return function (s) { return l(s) !== r(s); };
      if (eq.op === '==') return function (s) { return l(s) == r(s); };
      return function (s) { return l(s) != r(s); };
    }
    if (e[0] === '!') { var not = compileExpr(e.slice(1)); return function (s) { return !not(s); }; }
    if (e === 'true') return function () { return true; };
    if (e === 'false') return function () { return false; };
    if (e === 'null') return function () { return null; };
    if (e === 'undefined') return undef;
    if (NUMBER.test(e)) { var num = Number(e); return function () { return num; }; }
    if (e.length >= 2 && (e[0] === '"' || e[0] === "'") && e[e.length - 1] === e[0]) { var str = e.slice(1, -1); return function () { return str; }; }
    return compilePath(e);
  }

  function wrapsWhole(e) {
    for (var i = 0, d = 0; i < e.length - 1; i++) { if (e[i] === '(') d++; else if (e[i] === ')' && --d === 0) return false; }
    return true;
  }

  function findEquality(e) {
    for (var i = 0, d = 0; i < e.length; i++) {
      var c = e[i];
      if (c === '(' || c === '[') d++;
      else if (c === ')' || c === ']') d--;
      else if (d === 0 && (c === '=' || c === '!') && e[i + 1] === '=' && i > 0) return { at: i, op: e[i + 2] === '=' ? c + '==' : c + '=' };
    }
    return null;
  }

  function compilePath(e) {
    var m = e.match(IDENT);
    if (!m) return undef;
    var steps = [m[0]], r = m[0].length;
    while (r < e.length) {
      if (e[r] === '.') {
        var k = e.slice(r + 1).match(KEY);
        if (!k) return undef;
        steps.push(k[0]); r += 1 + k[0].length;
      } else if (e[r] === '[') {
        var d = 1, j = r + 1;
        for (; j < e.length && d > 0; j++) { if (e[j] === '[') d++; else if (e[j] === ']') d--; }
        if (d !== 0) return undef;
        steps.push(compileExpr(e.slice(r + 1, j - 1))); r = j;
      } else return undef;
    }
    return function (scope) {
      var cur = scope;
      for (var i = 0; i < steps.length; i++) {
        if (cur == null) return undefined;
        var s = steps[i];
        cur = cur[typeof s === 'function' ? s(scope) : s];
      }
      return cur;
    };
  }

  var WHOLE = /^\s*\{\{([^{}]+)\}\}\s*$/, HOLES = /\{\{([^{}]+)\}\}/g;

  // An attribute's value: one whole hole gives its value as it is; holes inside text give text.
  function compileValue(str) {
    if (str == null) return function () { return ''; };
    var m = WHOLE.exec(str);
    if (m) return compileExpr(m[1]);
    if (str.indexOf('{{') < 0) return function () { return str; };
    var parts = str.split(HOLES), fns = parts.map(function (p, i) { return i % 2 ? compileExpr(p) : null; });
    return function (s) {
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        if (i % 2) { var v = fns[i](s); out += v == null ? '' : String(v); } else out += parts[i];
      }
      return out;
    };
  }

  // ---- The template, compiled once into functions of (scope, key) that give React nodes ----------------------------

  var EVENTS = {};
  ('click change input submit keyDown keyUp keyPress mouseDown mouseUp mouseEnter mouseLeave mouseMove mouseOver mouseOut ' +
    'focus blur doubleClick contextMenu scroll wheel pointerDown pointerUp pointerMove pointerEnter pointerLeave pointerCancel ' +
    'touchStart touchEnd touchMove dragStart dragEnd dragEnter dragLeave dragOver drop paste copy animationEnd transitionEnd')
    .split(' ').forEach(function (n) { EVENTS['on' + n.toLowerCase()] = 'on' + n[0].toUpperCase() + n.slice(1); });
  EVENTS.ondblclick = 'onDoubleClick';
  var BOOLEAN = new Set(('allowFullScreen async autoFocus autoPlay checked controls default defer disabled formNoValidate hidden ' +
    'loop multiple muted noValidate open playsInline readOnly required reversed selected').split(' '));
  var BOOLEAN_LOWER = new Map(Array.from(BOOLEAN).map(function (b) { return [b.toLowerCase(), b]; }));

  function camel(name) { return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  var styleCache = new Map();
  function styleObject(v) {
    if (typeof v !== 'string') return v;
    var hit = styleCache.get(v);
    if (hit) return hit;
    var out = {};
    v.split(';').forEach(function (decl) {
      var c = decl.indexOf(':');
      if (c < 0) return;
      var prop = decl.slice(0, c).trim();
      if (prop) out[prop.indexOf('--') === 0 ? prop : camel(prop.toLowerCase())] = decl.slice(c + 1).trim();
    });
    if (styleCache.size > 2000) styleCache.clear();
    styleCache.set(v, out);
    return out;
  }

  function renderAll(fns, scope) {
    var out = new Array(fns.length);
    for (var i = 0; i < fns.length; i++) out[i] = fns[i](scope, i);
    return out;
  }

  function compileChildren(nodes, ctx) {
    var out = [];
    nodes.forEach(function (n) { var f = compileNode(n, ctx); if (f) out.push(f); });
    return out;
  }

  function compileNode(node, ctx) {
    if ('text' in node) return node.raw ? constant(node.text) : compileText(node.text);
    switch (node.lower) {
      case 'sc-for': return compileFor(node, ctx);
      case 'sc-if': return compileIf(node, ctx);
      case 'x-import': return compileImport(node, ctx);
      case 'helmet': ctx.helmet.push(ctx.src.slice(node.innerStart, node.innerEnd)); return null;
      default: return compileElement(node, ctx);
    }
  }

  function constant(t) { return function () { return t; }; }

  // Text: a run of only line breaks and tabs is the markup's layout and is dropped; any other text is kept. Each hole
  // renders in a span of its own (class sc-interp), as the canvas renders it, so a board lays out the same here.
  function compileText(t) {
    if (t.indexOf('{{') < 0) return !t.trim() && t.indexOf(' ') < 0 ? null : constant(t);
    var parts = t.split(HOLES), fns = parts.map(function (p, i) { return i % 2 ? compileExpr(p) : null; });
    return function (scope, key) {
      var kids = [];
      for (var i = 0; i < parts.length; i++) {
        if (!(i % 2)) { if (parts[i]) kids.push(parts[i]); continue; }
        var v = fns[i](scope);
        if (v === undefined) warnOnce('{{ ' + parts[i].trim() + ' }} never resolved, so it renders as nothing');
        else if (React.isValidElement(v) || Array.isArray(v)) kids.push(h(Fragment, { key: i }, v));
        else if (v !== null && typeof v !== 'boolean') kids.push(h('span', { key: i, className: 'sc-interp' }, String(v)));
      }
      return h.apply(null, [Fragment, { key: key }].concat(kids));
    };
  }

  function compileFor(node, ctx) {
    var src = attr(node, 'list') || '', list = compileValue(src), as = attr(node, 'as') || 'item';
    var kids = compileChildren(node.children, ctx);
    return function (scope, key) {
      var items = list(scope);
      if (!Array.isArray(items)) {
        if (items != null) warnOnce('sc-for list="' + src + '" is not a list (' + typeof items + ')');
        items = [];
      }
      return h(Fragment, { key: key }, items.map(function (item, i) {
        var s = Object.create(scope);
        s[as] = item; s.$index = i;
        return h(Fragment, { key: i }, renderAll(kids, s));
      }));
    };
  }

  function compileIf(node, ctx) {
    var test = compileValue(attr(node, 'value') || '');
    var kids = compileChildren(node.children, ctx);
    return function (scope, key) { return test(scope) ? h(Fragment, { key: key }, renderAll(kids, scope)) : null; };
  }

  // A component of the design system. Its attributes are its props: a name-with-dashes becomes camelCase
  // (on-click → onClick, min-width → minWidth), but aria-* and data-* stay as written, for the element it renders.
  //
  // Each component sits in a <div class="sc-host-x" style="display: contents">, as on the canvas: it takes no part in
  // layout, but selectors such as :first-child see it, so the boards lay out as they do there. A style attribute on
  // the import places that box instead (only position, inset, size, z-index and transform are taken).
  var HOST_STYLE = new Set(['position', 'left', 'right', 'top', 'bottom', 'inset', 'width', 'height', 'zIndex', 'transform']);
  function compileImport(node, ctx) {
    var path = attr(node, 'component-from-global-scope') || '';
    var props = [], hostStyle = null;
    node.attrs.forEach(function (a) {
      var name = a[0], value = a[1] == null ? '' : a[1];
      if (name === 'style') { hostStyle = compileValue(value); return; }
      if (name === 'component-from-global-scope' || name === 'component' || name === 'from' || name === 'hint-size' || name.indexOf('style-') === 0) return;
      if (name.indexOf('-') > 0 && !/^(aria|data)-/.test(name)) name = camel(name);
      props.push([name, compileValue(value)]);
    });
    var hasKids = node.children.some(function (c) { return !('text' in c) || c.text.trim(); });
    var kids = hasKids ? compileChildren(node.children, ctx) : [];
    var steps = path.split('.').filter(Boolean);
    return function (scope, key) {
      var box = { display: 'contents' };
      if (hostStyle) {
        var placed = {}, any = false, all = styleObject(hostStyle(scope)) || {};
        Object.keys(all).forEach(function (k) { if (HOST_STYLE.has(k)) { placed[k] = all[k]; any = true; } });
        if (any) box = placed;
      }
      var C = window;
      for (var i = 0; i < steps.length && C != null; i++) C = C[steps[i]];
      if (typeof C !== 'function' && !(C && typeof C === 'object' && C.$$typeof)) {
        warnOnce('no component ' + path);
        return h('div', { key: key, className: 'sc-host-x', style: box }, h('span', { className: 'dc-missing' }, path || 'x-import without a component'));
      }
      var p = {};
      for (var j = 0; j < props.length; j++) {
        var v = props[j][1](scope);
        if (props[j][0] === 'dcProps') { if (v && typeof v === 'object') Object.assign(p, v); continue; }
        p[props[j][0]] = v;
      }
      if (kids.length) p.children = renderAll(kids, scope);
      return h('div', { key: key, className: 'sc-host-x', style: box }, h(C, p));
    };
  }

  // Plain HTML: class → className, for → htmlFor, onclick or on-click → onClick, a style string → a style object, and
  // an attribute such as disabled with no value → true.
  function compileElement(node, ctx) {
    var props = [];
    node.attrs.forEach(function (a) {
      var name = a[0], value = a[1] == null ? '' : a[1], get = null;
      var low = name.toLowerCase();
      if (low === 'class') name = 'className';
      else if (low === 'for') name = 'htmlFor';
      else if (/^on./i.test(name) && !/^on[A-Z]/.test(name)) name = name.indexOf('-') > 0 ? camel(name) : (EVENTS[low] || 'on' + name[2].toUpperCase() + name.slice(3));
      else if (low === 'checked' && node.lower === 'input' && value.indexOf('{{') < 0) { name = 'defaultChecked'; get = constant(true); }
      else if (value === '' && BOOLEAN_LOWER.has(low)) { name = BOOLEAN_LOWER.get(low); get = constant(true); }
      get = get || compileValue(value);
      if (low === 'style') { var raw = get; get = function (s) { return styleObject(raw(s)); }; }
      props.push([name, get]);
    });
    var kids = compileChildren(node.children, ctx), tag = node.tag;
    return function (scope, key) {
      var p = { key: key };
      for (var i = 0; i < props.length; i++) {
        var name = props[i][0], v = props[i][1](scope);
        // An input's value or checked hole that is empty gives '' or false, so the input stays controlled.
        if (v === undefined && (name === 'value' || name === 'checked')) v = name === 'checked' ? false : '';
        p[name] = v;
      }
      return kids.length ? h(tag, p, renderAll(kids, scope)) : h(tag, p);
    };
  }

  // ---- The board's logic ---------------------------------------------------------------------------------------------

  var TEMPLATE = null;

  // A board's class extends this. It is not a React component but is held by one (Host), as on the canvas: setState
  // changes this.state at once and then renders, so a handler that sets state and reads it straight after sees the
  // new state, which React's own setState would not give it until the next render.
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; this.__host = null; }
    setState(update, done) { if (this.__host) this.__host.setLogicState(update, done); }
    forceUpdate(done) { if (this.__host) this.__host.forceUpdate(done); }
    componentDidMount() {}
    componentDidUpdate() {}
    componentWillUnmount() {}
    renderVals() { return {}; }
  }
  window.DCLogic = DCLogic;

  // Holds the board's logic and renders the template with the props and what renderVals() returns. After every
  // update it calls the logic's componentDidUpdate with the props before it, as React calls a component's.
  class Host extends React.Component {
    constructor(p) {
      super(p);
      this.state = { v: 0 };
      try { this.logic = new p.Logic(p.props); } catch (e) {
        console.error('[dc] ' + FILE + ': the constructor failed, so the template renders with props only.', e);
        this.logic = new DCLogic(p.props);
      }
      this.logic.__host = this;
    }
    setLogicState(update, done) {
      var before = this.logic.state;
      var patch = typeof update === 'function' ? update(before, this.logic.props) : update;
      this.logic.state = Object.assign({}, before, patch);
      this.setState(function (s) { return { v: s.v + 1 }; }, done);
    }
    componentDidMount() { try { this.logic.componentDidMount(); } catch (e) { console.error(e); } }
    componentDidUpdate(prev) {
      this.logic.props = this.props.props;
      try { this.logic.componentDidUpdate(prev.props); } catch (e) { console.error(e); }
    }
    componentWillUnmount() { try { this.logic.componentWillUnmount(); } catch (e) { console.error(e); } }
    render() {
      var vals = Object.assign(Object.create(null), this.props.props);
      this.logic.props = this.props.props;
      try { Object.assign(vals, this.logic.renderVals() || {}); } catch (e) {
        console.error(e);
        return h('div', { className: 'sc-host sc-has-error' }, errorBox(FILE + ' renderVals(): ' + (e && e.message || e)));
      }
      return h('div', { className: 'sc-host' }, TEMPLATE ? renderAll(TEMPLATE, vals) : null);
    }
  }

  function errorBox(msg) { return h('div', { className: 'dc-error', role: 'alert' }, msg); }

  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err: err }; }
    componentDidCatch(err) { console.error('[dc] ' + FILE + ' failed to render:', err); }
    componentDidUpdate(prev) { if (prev.props !== this.props.props && this.state.err) this.setState({ err: null }); }
    render() { return this.state.err ? errorBox(FILE + ': ' + (this.state.err.message || this.state.err)) : this.props.children; }
  }

  // ---- Starting the board ---------------------------------------------------------------------------------------------

  var BASE_CSS = 'html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}' +
    '.dc-error{position:fixed;top:8px;left:8px;right:8px;z-index:2147483647;padding:8px 12px;background:#b00020;color:#fff;' +
    'font:12px/1.45 ui-monospace,monospace;border-radius:4px;white-space:pre-wrap}' +
    '.dc-missing{display:inline-block;padding:2px 6px;border:1px dashed #b00020;color:#b00020;font:12px ui-monospace,monospace}';

  function propsOf(def, overrides) {
    var p = {};
    Object.keys(def).forEach(function (k) { if (k[0] !== '$' && def[k] && 'default' in def[k]) p[k] = def[k].default; });
    return Object.assign(p, overrides || {});
  }

  function post(msg) { if (EMBEDDED) window.parent.postMessage(msg, location.origin); }

  async function boot() {
    var host = document.querySelector('x-dc');
    var script = document.querySelector('script[data-dc-script]');
    if (!host) { console.error('[dc] ' + FILE + ' has no <x-dc> template.'); return; }
    // The template is read from the file itself: the browser's own reading of it lowercases names and moves markup.
    var src = await fetch(location.href.split('#')[0], { cache: 'no-store' }).then(function (r) { return r.text(); });
    var from = src.indexOf('<x-dc>'), to = src.lastIndexOf('</x-dc>');
    var tpl = from < 0 || to < 0 ? '' : src.slice(from + 6, to);
    var ctx = { helmet: [], src: tpl };
    TEMPLATE = compileChildren(parse(tpl).children, ctx);
    ctx.helmet.forEach(function (html) {
      if (html.indexOf('{{') >= 0) warnOnce('holes in <helmet> are not filled here');
      document.head.insertAdjacentHTML('beforeend', html);
    });
    var base = document.createElement('style');
    base.textContent = BASE_CSS;
    document.head.appendChild(base);

    var def = {};
    try { def = JSON.parse(script && script.getAttribute('data-props') || '{}'); } catch (e) { console.error('[dc] ' + FILE + ': data-props is not JSON', e); }
    var Logic = DCLogic;
    if (script && script.textContent.trim()) {
      try {
        var made = new Function('DCLogic', 'StreamableLogic', 'React', script.textContent +
          '\n;return typeof Component !== "undefined" ? Component : undefined;\n//# sourceURL=' + FILE + '.logic.js')(DCLogic, DCLogic, React);
        if (typeof made === 'function') Logic = made;
        else console.error('[dc] ' + FILE + ': the script must define `class Component extends DCLogic`.');
      } catch (e) { console.error('[dc] ' + FILE + ': the logic failed to load, so the template renders with props only.', e); }
    }

    var overrides = {};
    try { if (HASH.get('tweaks')) overrides = JSON.parse(HASH.get('tweaks')); } catch (e) { console.warn('[dc] tweaks in the URL are not JSON'); }
    var mount = document.createElement('div');
    mount.id = 'dc-root';
    host.replaceWith(mount);
    var root = ReactDOM.createRoot(mount);
    var props = propsOf(def, overrides);
    function render() { root.render(h(Boundary, { props: props }, h(Host, { Logic: Logic, props: props }))); }
    // flushSync, so the board is on the page when boot ends (the check and the viewer read it straight after).
    ReactDOM.flushSync(render);

    window.__dc = {
      ready: true, file: FILE, props: def,
      tweaks: function () { return Object.assign({}, props); },
      setTweaks: function (values) { props = propsOf(def, values); ReactDOM.flushSync(render); }
    };
    post({ dc: 'ready', file: FILE, title: document.title, props: def });
  }

  // ---- Inside the viewer ------------------------------------------------------------------------------------------------

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.origin !== location.origin || !e.data || e.data.dc !== 'tweaks' || !window.__dc) return;
    window.__dc.setTweaks(e.data.values || {});
  });

  // A link to another board, in the viewer, opens that board there; anything else behaves as a link does.
  document.addEventListener('click', function (e) {
    if (!EMBEDDED || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self')) return;
    var url = new URL(a.getAttribute('href'), location.href);
    if (url.origin !== location.origin || !/\.dc\.html$/.test(url.pathname)) return;
    e.preventDefault();
    post({ dc: 'navigate', href: decodeURIComponent(url.pathname.split('/').pop()), from: FILE });
  });

  // On the canvas, the wheel moves the canvas, unless it is over something in the board that scrolls that way.
  function scrollsThatWay(el, dx, dy) {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      var cs = getComputedStyle(el);
      if (dy && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 &&
        (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
      if (dx && /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 &&
        (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
    }
    return false;
  }
  if (ON_WALL) {
    window.addEventListener('wheel', function (e) {
      var zoom = e.ctrlKey || e.metaKey;
      if (!zoom && scrollsThatWay(e.target, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      post({ dc: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, zoom: zoom, x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  // Playing, Esc stops playing, unless the board used it or it was pressed in a field.
  if (PLAYING) {
    window.addEventListener('keydown', function (e) {
      var t = e.target;
      if (e.key !== 'Escape' || e.defaultPrevented || (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable))) return;
      post({ dc: 'escape' });
    });
  }

  window.addEventListener('error', function (e) { post({ dc: 'error', file: FILE, message: String(e.message) }); });

  function start() { boot().catch(function (e) { console.error('[dc] ' + FILE + ' failed to start:', e); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
