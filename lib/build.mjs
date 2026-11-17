// Builds a design system from its source and installs it for the boards (`design-kit build [--check]`).
//
// From the system's folder (README.md → A design system's folder) it writes dist/:
//   tokens.css    tokens.json (W3C design tokens) as CSS: each colour, shadow, dimension and font family a custom
//                 property named by its key, each typography token a class
//   bundle.js     src/index.jsx bundled for a page that has React (window.React): it puts the namespace object on
//                 window.<namespace>, headed by the list of components claude.ai's canvas reads
//   bundle.css    src/bundle.css as it is
//   index.mjs     the same components as a module for an app, which imports React itself
//   index.d.ts    every component's types (components/<Name>/<Name>.d.ts), and the namespace's
// and installs tokens.css, tokens.json (in claude.ai's format) and components/bundle.js and .css where the config's
// system.install says, which is where the boards load them from. A file is written only when it changes.
//
// It refuses a CSS variable that nothing defines (a token, the stylesheet, or a component setting it inline), a token
// key used twice, and an alias to no token. Then it renders every story (each named export of components/*/*.stories.js)
// with React on the server, as a check. --check writes nothing and exits 1 when anything built differs from what is on
// disk.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { KIT } from './config.mjs';
import { writtenOrder, storyNames, storyArgs, storyElement } from './stories.mjs';

const require = createRequire(path.join(KIT, 'package.json'));   // the kit's own dependencies: esbuild, react, react-dom
const EXT = 'design-kit';                                       // our key under a token's $extensions

// ---- Tokens ------------------------------------------------------------------------------------------------------------

// Every token in document order: { path, key, type, value, description, sample, group }. A group's $type applies to
// what it holds, as DTCG has it.
export function readTokens(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = [];
  const walk = (node, at, type) => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$') || !v || typeof v !== 'object') continue;
      if ('$value' in v) {
        const ext = (v.$extensions && v.$extensions[EXT]) || {};
        list.push({ path: [...at, k].join('.'), key: k, type: v.$type || type, value: v.$value, description: v.$description || '', sample: ext.sample, group: at });
      } else walk(v, [...at, k], v.$type || type);
    }
  };
  walk(doc, [], doc.$type);
  const byPath = new Map(list.map((t) => [t.path, t]));
  const meta = (doc.$extensions && doc.$extensions[EXT]) || {};
  return { doc, list, byPath, name: meta.name, themes: meta.themes || [] };
}

const ALIAS = /^\{([^{}]+)\}$/;

function check(tokens) {
  const errors = [];
  const seen = new Map();
  for (const t of tokens.list) {
    if (!t.type) errors.push(t.path + ' has no $type, nor has its group');
    const space = t.type === 'typography' ? 'class' : 'property';
    const k = space + ':' + t.key;
    if (seen.has(k)) errors.push(`${t.path} and ${seen.get(k)} are both ${space === 'class' ? '.' : '--'}${t.key}`);
    seen.set(k, t.path);
    const each = (v) => { if (typeof v === 'string') { const m = v.match(ALIAS); if (m && !tokens.byPath.has(m[1])) errors.push(t.path + ' refers to ' + v + ', which is no token'); } else if (v && typeof v === 'object') Object.values(v).forEach(each); };
    each(t.value);
  }
  return errors;
}

// A token's value as CSS: an alias is the variable it names; a literal is written out.
function cssValue(tokens, v, type) {
  if (typeof v === 'string') {
    const m = v.match(ALIAS);
    if (m) return 'var(--' + tokens.byPath.get(m[1]).key + ')';
    return type === 'color' && v.startsWith('#') ? v.toLowerCase() : v;
  }
  if (type === 'fontFamily') return [].concat(v).map((f) => (/\s/.test(f) ? '"' + f + '"' : f)).join(', ');
  if (type === 'shadow') {
    return [].concat(v).map((s) => {
      const spread = s.spread && !/^0(px)?$/.test(s.spread) ? ' ' + s.spread : '';
      return (s.inset ? 'inset ' : '') + [s.offsetX, s.offsetY, s.blur].join(' ') + spread + ' ' + cssValue(tokens, s.color, 'color');
    }).join(', ');
  }
  if (type === 'cubicBezier') return 'cubic-bezier(' + v.join(', ') + ')';
  return String(v);
}

// A token's value with every alias followed: what the viewer shows.
export function resolve(tokens, v, depth = 0) {
  if (depth > 20) throw new Error('alias loop at ' + JSON.stringify(v));
  if (typeof v === 'string') { const m = v.match(ALIAS); return m ? resolve(tokens, tokens.byPath.get(m[1]).value, depth + 1) : v; }
  if (Array.isArray(v)) return v.map((x) => resolve(tokens, x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(tokens, x, depth + 1)]));
  return v;
}
export const literal = (tokens, t) => cssValue(tokens, resolve(tokens, t.value), t.type);

const THEMED = new Set(['color', 'shadow']);

export function tokensCss(tokens, title) {
  const out = ['/* ' + (tokens.name || title || 'Design system') + ' — generated from tokens.json */'];
  const theme = tokens.themes[0];
  out.push(theme ? `:root, [data-theme="${theme.id}"] {` : ':root {');
  for (const t of tokens.list) if (THEMED.has(t.type)) out.push(`  --${t.key}: ${cssValue(tokens, t.value, t.type)};`);
  out.push('}', ':root {');
  for (const t of tokens.list) if (!THEMED.has(t.type) && t.type !== 'typography') out.push(`  --${t.key}: ${cssValue(tokens, t.value, t.type)};`);
  out.push('}');
  for (const t of tokens.list) {
    if (t.type !== 'typography') continue;
    const v = t.value, decl = [];
    if (v.fontFamily != null) decl.push('font-family: ' + cssValue(tokens, v.fontFamily, 'fontFamily'));
    if (v.fontSize != null) decl.push('font-size: ' + cssValue(tokens, v.fontSize, 'dimension'));
    if (v.lineHeight != null) decl.push('line-height: ' + cssValue(tokens, v.lineHeight, 'number'));
    if (v.fontWeight != null) decl.push('font-weight: ' + cssValue(tokens, v.fontWeight, 'fontWeight'));
    if (v.letterSpacing != null) decl.push('letter-spacing: ' + cssValue(tokens, v.letterSpacing, 'dimension'));
    out.push(`.${t.key} { ${decl.join('; ')}; }`);
  }
  return out.join('\n') + '\n';
}

// The same tokens in the format claude.ai's design systems keep (what a canvas installs as tokens.json), so a canvas
// shared there stays in step. Its families are color, shadow, each dimension group, and type (families and groups).
export function claudeTokens(tokens) {
  const meta = (tokens.doc.$extensions && tokens.doc.$extensions[EXT]) || {};
  const plain = (v) => (typeof v === 'string' ? v.replace(ALIAS, (_, p) => '{' + tokens.byPath.get(p).key + '}') : v);
  const one = (t) => { const o = { name: t.key, value: t.type === 'shadow' ? cssValue(tokens, t.value, 'shadow').replace(/var\(--([\w-]+)\)/g, '{$1}') : plain(t.value) }; if (t.description) o.usage = t.description; return o; };
  const out = { name: meta.name, version: meta.version };
  const families = {}, groups = [];
  for (const [k, g] of Object.entries(tokens.doc)) {
    if (k.startsWith('$')) continue;
    const mine = tokens.list.filter((t) => t.group[0] === k);
    if (g.$type === 'fontFamily') { for (const t of mine) families[t.key.replace(/^font-/, '')] = cssValue(tokens, t.value, 'fontFamily'); continue; }
    if (g.$type === 'typography') {
      for (const [name] of Object.entries(g).filter(([n]) => !n.startsWith('$'))) {
        const styles = mine.filter((t) => t.group[1] === name);
        const fam = (t) => tokens.byPath.get(t.value.fontFamily.match(ALIAS)[1]).key.replace(/^font-/, '');
        const family = fam(styles[0]);
        groups.push({ name, family, styles: styles.map((t) => {
          const s = { name: t.key, fontSize: t.value.fontSize, lineHeight: t.value.lineHeight, fontWeight: t.value.fontWeight };
          if (t.value.letterSpacing != null) s.letterSpacing = t.value.letterSpacing;
          if (fam(t) !== family) s.family = fam(t);
          if (t.sample != null) s.sample = t.sample;
          if (t.description) s.usage = t.description;
          return s;
        }) });
      }
      continue;
    }
    const fam = {};
    if (g.$description) fam.note = g.$description;
    if (k === 'color') fam.themes = meta.themes || [];
    fam.tokens = mine.map(one);
    out[k] = fam;
  }
  out.type = { fonts: [], families, groups };
  return out;
}

// ---- The components ------------------------------------------------------------------------------------------------------

// The kit's esbuild options; a config's system.esbuild goes over them (a JSX factory, a target, minifying).
const BUILD = { bundle: true, target: 'es2020', legalComments: 'none' };
const MUST = { write: false, logLevel: 'silent' };

// On a page, React is the page's: an import of react or react-dom reads window.React or window.ReactDOM.
const pageReact = {
  name: 'page-react',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/client)?$/ }, (a) => ({ path: a.path, namespace: 'page-react' }));
    b.onLoad({ filter: /.*/, namespace: 'page-react' }, (a) => ({ contents: 'module.exports = window.' + (a.path.startsWith('react-dom') ? 'ReactDOM' : 'React') + ';', loader: 'js' }));
  },
};

async function bundles(sys) {
  const esbuild = require('esbuild');
  const src = path.join(sys.dir, 'src');
  const opts = { ...BUILD, ...sys.esbuild, ...MUST };
  // For the boards: the module's default export on window.<namespace>, merged with what is there.
  const iife = await esbuild.build({ ...opts, format: 'iife', absWorkingDir: sys.dir, plugins: [pageReact],
    stdin: { contents: `import ns from './src/index.jsx';\nwindow.${sys.namespace} = Object.assign(window.${sys.namespace} || {}, ns);\n`, resolveDir: sys.dir, sourcefile: 'global.js', loader: 'js' } });
  // For an app: React imported, not read from the page.
  const esm = await esbuild.build({ ...opts, format: 'esm', absWorkingDir: sys.dir, entryPoints: [path.join(src, 'index.jsx')], external: ['react', 'react-dom'],
    banner: { js: "import * as __kitReact from 'react';" }, define: { 'window.React': '__kitReact', 'window.document': 'globalThis.document' } });
  return { iife: iife.outputFiles[0].text, esm: esm.outputFiles[0].text };
}

// The namespace object the bundle makes, read by running it with no React: its keys, in order.
function namespaceOf(js, ns) {
  const win = {};
  vm.runInNewContext(js, { window: win, console });
  if (!win[ns]) throw new Error('the bundle put nothing on window.' + ns);
  return win[ns];
}

const componentDirs = (sys) => {
  const d = path.join(sys.dir, 'components');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isDirectory()) : [];
};

function typesOf(sys, keys) {
  const parts = ["import type * as React from 'react';", ''];
  const declared = new Set();
  const dirs = new Set(componentDirs(sys));
  for (const name of [...keys.filter((k) => dirs.has(k)), ...[...dirs].filter((d) => !keys.includes(d))]) {
    const f = path.join(sys.dir, 'components', name, name + '.d.ts');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8').replace(/^\/\/.*\n/, '');
    for (const m of text.matchAll(/export declare (?:function|const) (\w+)/g)) declared.add(m[1]);
    parts.push(text.trimEnd(), '');
  }
  return { parts, declared };
}

// ---- Stories -----------------------------------------------------------------------------------------------------------

// Each story file, imported in this process with React and the namespace on a stand-in window. Returns
// [{ name, file, meta, stories: { exportName: story } }] in CSF's order (stories.mjs); one that fails to load has
// `error`.
export async function loadStories(sys, js, version = '') {
  const React = require('react');
  const win = { React };
  new vm.Script(js).runInNewContext({ window: win, console });
  globalThis.window = Object.assign(globalThis.window || {}, { React, [sys.namespace]: win[sys.namespace] });
  const out = [];
  for (const name of componentDirs(sys)) {
    const file = path.join(sys.dir, 'components', name, name + '.stories.js');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href + (version ? '?v=' + version : ''));
      const stories = Object.fromEntries(storyNames(mod, writtenOrder(fs.readFileSync(file, 'utf8'))).map((k) => [k, mod[k]]));
      out.push({ name, file, meta: mod.default || {}, stories });
    } catch (e) {
      out.push({ name, file, meta: {}, stories: {}, error: e.message });
    }
  }
  return out;
}

async function renderStories(sys, js) {
  const React = require('react'), server = require('react-dom/server');
  const failures = [], warnings = new Set();
  const err = console.error;
  console.error = (...a) => warnings.add(String(a[0]).split('\n')[0].slice(0, 140));
  let n = 0;
  try {
    for (const s of await loadStories(sys, js)) {
      if (s.error) { failures.push(s.name + ': ' + s.error); continue; }
      if (!Object.keys(s.stories).length) failures.push(s.name + ': no stories');
      for (const [k, story] of Object.entries(s.stories)) {
        n++;
        try {
          const html = server.renderToStaticMarkup(React.createElement('div', { className: 'pv' }, storyElement(React, s.meta, story, storyArgs(s.meta, story), k)));
          if (html.length < 50) failures.push(`${s.name}/${k}: rendered nothing`);
        } catch (e) { failures.push(`${s.name}/${k}: ${e.message}`); }
      }
    }
  } finally { console.error = err; }
  return { count: n, failures, warnings: [...warnings] };
}

// ---- Building and installing -------------------------------------------------------------------------------------------

function sameJson(a, b) {
  const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
  return canon(a) === canon(b);
}

// Everything the build makes, as { files: { absolute path: text }, errors, components, namespace keys }.
export async function build(cfg) {
  const sys = cfg.system;
  if (!sys) throw new Error('This config has no system.');
  const errors = [];
  const tokens = readTokens(path.join(sys.dir, 'tokens.json'));
  errors.push(...check(tokens));
  if (errors.length) return { errors, files: {} };
  const css = tokensCss(tokens, cfg.title);
  const stylesheet = fs.readFileSync(path.join(sys.dir, 'src/bundle.css'), 'utf8');
  const source = fs.readFileSync(path.join(sys.dir, 'src/index.jsx'), 'utf8');

  // Every variable the stylesheet uses is a token, set in the stylesheet itself, or set inline by a component.
  const defined = new Set(tokens.list.filter((t) => t.type !== 'typography').map((t) => t.key));
  for (const m of stylesheet.matchAll(/--([\w-]+)\s*:/g)) defined.add(m[1]);
  for (const m of source.matchAll(/['"]--([\w-]+)['"]/g)) defined.add(m[1]);
  const undefinedVars = [...new Set([...stylesheet.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]))].filter((v) => !defined.has(v));
  if (undefinedVars.length) errors.push('bundle.css uses variables nothing defines: ' + undefinedVars.map((v) => '--' + v).join(', '));

  let b;
  try { b = await bundles(sys); } catch (e) { errors.push('esbuild: ' + (e.errors ? e.errors.map((x) => (x.location ? `${x.location.file}:${x.location.line}: ` : '') + x.text).join('; ') : e.message)); }
  if (errors.length) return { errors, files: {} };

  const ns = namespaceOf(b.iife, sys.namespace);
  const keys = Object.keys(ns);
  const dirs = new Set(componentDirs(sys));
  const components = keys.filter((k) => typeof ns[k] === 'function' && dirs.has(k));
  for (const d of dirs) if (!keys.includes(d)) errors.push(`components/${d}/ is not in the ${sys.namespace} object`);
  const header = '/* @ds-bundle: ' + JSON.stringify({ format: 4, namespace: sys.namespace, components: components.map((name) => ({ name })) }) + ' */\n';
  const js = header + b.iife;
  if (/<\/script|<!--/i.test(js)) errors.push('the bundle holds </script or <!--, which would end a page\'s inline script');

  const { parts, declared } = typesOf(sys, keys);
  const missing = keys.filter((k) => !declared.has(k));
  parts.push(`declare const ${sys.namespace}: {\n${keys.filter((k) => declared.has(k)).map((k) => `  ${k}: typeof ${k};`).join('\n')}\n};`,
    `export default ${sys.namespace};`, `declare global { interface Window { ${sys.namespace}: typeof ${sys.namespace} } }`, '');

  const dist = path.join(sys.dir, 'dist');
  const files = {
    [path.join(dist, 'tokens.css')]: css,
    [path.join(dist, 'bundle.js')]: js,
    [path.join(dist, 'bundle.css')]: stylesheet,
    [path.join(dist, 'index.mjs')]: b.esm,
    [path.join(dist, 'index.d.ts')]: parts.join('\n'),
  };
  const json = {};
  if (sys.install) {
    files[path.join(sys.install, 'tokens.css')] = css;
    files[path.join(sys.install, 'components/bundle.js')] = js;
    files[path.join(sys.install, 'components/bundle.css')] = stylesheet;
    json[path.join(sys.install, 'tokens.json')] = claudeTokens(tokens);
  }
  return { errors, files, json, components, keys, untyped: missing, js };
}

// Writes what changed; returns the paths written. A JSON file that holds the same value, however laid out, is kept.
export function write(result) {
  const written = [];
  for (const [file, text] of Object.entries(result.files)) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(file);
  }
  for (const [file, value] of Object.entries(result.json || {})) {
    if (fs.existsSync(file) && sameJson(JSON.parse(fs.readFileSync(file, 'utf8')), value)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

export function differs(result) {
  const out = [];
  for (const [file, text] of Object.entries(result.files)) if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) out.push(file);
  for (const [file, value] of Object.entries(result.json || {})) if (!fs.existsSync(file) || !sameJson(JSON.parse(fs.readFileSync(file, 'utf8')), value)) out.push(file);
  return out;
}

// `design-kit build [--check]`: builds, writes what changed (or, with check, only says what would), renders every
// story. Resolves to the exit code.
export async function buildCommand(cfg, { check = false } = {}) {
  if (!cfg.system) { console.error('This config has no system.'); return 1; }
  const rel = (f) => path.relative(process.cwd(), f);
  const result = await build(cfg);
  if (result.errors.length) { for (const e of result.errors) console.error('✗ ' + e); return 1; }
  const d = check ? differs(result) : [];
  if (check) {
    for (const f of d) console.log('  would change ' + rel(f));
    console.log(d.length ? d.length + ' files are not as the source builds them.' : 'Everything built is as on disk.');
  } else {
    const w = write(result);
    for (const f of w) console.log('  wrote ' + rel(f));
    console.log(`Built ${cfg.system.namespace}: ${result.components.length} components` + (w.length ? '' : ', nothing changed') + '.');
  }
  if (result.untyped.length) console.log(`  no types for ${result.untyped.join(', ')} (components/<Name>/<Name>.d.ts)`);
  const r = await renderStories(cfg.system, result.js);
  for (const f of r.failures) console.log('✗ story ' + f);
  console.log(r.failures.length ? `${r.failures.length} of ${r.count} stories failed.` : `All ${r.count} stories render.`);
  if (r.warnings.length) console.log('  React warned: ' + r.warnings.slice(0, 6).join(' | '));
  return r.failures.length || d.length ? 1 : 0;
}
