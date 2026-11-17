// A project's design.config.json, which tells the kit where its design system and its canvas are. The kit holds no
// project's content: each project keeps its own folder (a config, a system, a canvas) and points the kit at it.
//
// Every path in it is relative to the config's folder:
//
//   title                 the canvas's name in the viewer, when canvas.json has none
//   system.dir            the design system's source (README.md → A design system's folder); leave `system` out for a
//                         canvas with none
//   system.namespace      the global the boards read its components from (window.<namespace>)
//   system.install        where the build installs it for the boards: tokens.css, tokens.json and components/bundle.js
//                         and bundle.css. Left out, it is only built
//   system.esbuild        options for esbuild over the kit's (target es2020, no legal comments): a JSX factory, a
//                         target, minifying
//   canvas.dir            canvas.json and the boards
//   canvas.artifact       the claude.ai canvas the sync keeps in step with, if any
//   comments, sync        the comments file, and the last sync with claude.ai (comments.json and sync.json by default)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit's own folder: runtime/, viewer/ and vendor/ are found from it.
export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The config a command means: --config <file>, else $DESIGN_CONFIG, else design.config.json or
// design/design.config.json in the working folder.
export function findConfig({ argv = process.argv, env = process.env, cwd = process.cwd() } = {}) {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return path.resolve(cwd, argv[i + 1]);
  if (env.DESIGN_CONFIG) return path.resolve(cwd, env.DESIGN_CONFIG);
  for (const p of ['design.config.json', 'design/design.config.json']) {
    if (fs.existsSync(path.join(cwd, p))) return path.join(cwd, p);
  }
  throw new Error('No design.config.json here or in design/: pass --config <file>.');
}

export function loadConfig(file = findConfig()) {
  file = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.dirname(file);
  const at = (p) => (p ? path.resolve(root, p) : null);
  if (!raw.canvas || !raw.canvas.dir) throw new Error(file + ': canvas.dir is required');
  const system = raw.system && raw.system.dir ? {
    dir: at(raw.system.dir),
    namespace: raw.system.namespace || 'DS',
    install: at(raw.system.install),
    esbuild: raw.system.esbuild || {},
  } : null;
  if (system && !/^[A-Za-z_$][\w$]*$/.test(system.namespace)) throw new Error(file + ': system.namespace must be a JavaScript name');
  return {
    file,
    root,
    title: raw.title || null,
    system,
    canvas: { dir: at(raw.canvas.dir), artifact: raw.canvas.artifact || null },
    comments: at(raw.comments || 'comments.json'),
    sync: at(raw.sync || 'sync.json'),
    fonts: system && fs.existsSync(path.join(system.dir, 'fonts/google.css')) ? path.join(system.dir, 'fonts') : null,
  };
}
