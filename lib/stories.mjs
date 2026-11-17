// What a story file means, in Component Story Format 3. The build reads it in Node, and the preview page in the browser
// (served as /kit/stories.mjs), so this module imports nothing and is handed React.
//
// A named export is a story (the file's meta's includeStories and excludeStories narrow that):
//   an object      { args, argTypes, render, decorators, parameters, name }. With no render, it renders the file's
//                  component (meta.component) with its args
//   a function     render(args, context), the older form
// Its args are the file's (meta.args) under its own. Decorators wrap it, its own inside the file's.

const isStory = (v) => typeof v === 'function' || (v !== null && typeof v === 'object' && !Array.isArray(v));
const matches = (rule, k) => (Array.isArray(rule) ? rule.includes(k) : rule instanceof RegExp ? rule.test(k) : false);

// The names a story file declares as exports, in the order written: CSF shows its stories in that order.
export function writtenOrder(text) {
  return [...text.matchAll(/export\s+(?:const|let|var|(?:async\s+)?function\*?)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

// A story module's stories, in CSF's order: its __namedExportsOrder when it has one, else as written; then any other.
export function storyNames(mod, written = []) {
  const meta = mod.default || {};
  const names = Object.keys(mod).filter((k) => k !== 'default' && k !== '__namedExportsOrder' && isStory(mod[k]) &&
    (meta.includeStories == null || matches(meta.includeStories, k)) && !matches(meta.excludeStories, k));
  const order = Array.isArray(mod.__namedExportsOrder) ? mod.__namedExportsOrder : written;
  return [...order.filter((k) => names.includes(k)), ...names.filter((k) => !order.includes(k))];
}

// Its name as shown: its own `name`, else the export's words (PrimaryButton → Primary Button).
export function storyTitle(key, story) {
  return (story && story.name) || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

export function storyArgs(meta, story) {
  return { ...(meta.args || {}), ...((story && story.args) || {}) };
}

// The element that renders a story with these args. The render runs inside a component, so it may use hooks.
export function storyElement(React, meta, story, args, key = '') {
  const context = { args, name: storyTitle(key, story), title: meta.title, parameters: { ...(meta.parameters || {}), ...(story.parameters || {}) } };
  const render = typeof story === 'function' ? story : story.render || meta.render ||
    (meta.component ? (a) => React.createElement(meta.component, a) : null);
  if (!render) throw new Error('it has no render, and the file names no component');
  let Current = () => render(args, context);
  for (const decorate of [...(story.decorators || []), ...(meta.decorators || [])]) {
    const Inner = Current;
    Current = () => decorate(Inner, context);
  }
  return React.createElement(Current);
}

// A control's editor from CSF's control type; the rest have none here.
const EDITORS = { select: 'enum', radio: 'enum', 'inline-radio': 'enum', boolean: 'boolean', text: 'text', number: 'number', range: 'number', color: 'color' };
const plain = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

// The controls a story's args get: each { name, editor, options?, min?, max?, step? }, the editors a board's tweaks
// have. An arg's argTypes say which (control: 'select' with options, …; control: false for none); with none, its value
// does (true or false, a number, text). A story whose render takes no args gets none, as nothing would change.
export function storyControls(meta, story, args) {
  const render = typeof story === 'function' ? story : story.render || meta.render;
  if (render && render.length === 0) return [];
  const types = { ...(meta.argTypes || {}), ...(story.argTypes || {}) };
  const out = [];
  for (const name of [...new Set([...Object.keys(args), ...Object.keys(types)])]) {
    const t = types[name] || {}, v = args[name];
    if (t.control === false) continue;
    const c = typeof t.control === 'string' ? { type: t.control } : t.control || {};
    const options = Array.isArray(t.options) ? t.options : null;
    const editor = c.type ? EDITORS[c.type] : options ? 'enum'
      : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'text' : null;
    if (!editor || (editor === 'enum' && !(options && options.every(plain)))) continue;
    const d = { name, editor };
    if (editor === 'enum') d.options = options;
    for (const k of ['min', 'max', 'step']) if (c[k] != null) d[k] = c[k];
    out.push(d);
  }
  return out;
}
