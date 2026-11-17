# design-kit

A design canvas and a design system, kept as files in your repository and shown in the browser.

- **The canvas** is a wall of boards: screens written in the `.dc.html` format, played live, with tweaks, sticky
  notes and comments. Boards link to each other, so a page of them is a clickable prototype.
- **The design system** is built from open formats: W3C design tokens, a React module, Component Story Format stories
  and Markdown. The kit builds it for the boards and for an app, and gives it a page of its own: the guide, the
  tokens, and every component's stories rendered live.

Everything runs on your machine: one Node process, no account, no connection. Its only dependencies are esbuild and
React.

```bash
npm install --save-dev https://github.com/the-human-mustachio/design-kit/releases/download/v0.1.0/design-kit-0.1.0.tgz
npx design-kit serve            # http://127.0.0.1:4400/
```

It isn't on npm yet. Each release's package is attached to its [GitHub release](https://github.com/the-human-mustachio/design-kit/releases):
the same files `npm publish` would send, which npm records in the lockfile with their checksum.

To try it, clone this repository and run `npm install`, then `npx design-kit serve --config example/design.config.json`.
`example/` is a small project with three components and three boards. It is also a starting point to copy.

## Commands

| Command | What it does |
|---|---|
| `design-kit serve [--port <n>]` | The viewer. It builds the design system on start and again whenever its source changes; any change on disk shows in every open window |
| `design-kit build [--check]` | Builds the design system, installs it for the boards, and renders every story as a check. `--check` writes nothing and exits 1 when anything built differs from what is on disk |
| `design-kit check [<board.dc.html> …]` | Plays every board and every tweak value in headless Chrome. It exits 1 on a board that errors, leaves a hole unresolved, or links to a board that doesn't exist |
| `design-kit sync …` | Keeps the canvas in step with a copy shared on claude.ai (below) |

Each command reads the project's `design.config.json`. It looks for `--config <file>`, then `$DESIGN_CONFIG`, then
`design.config.json` or `design/design.config.json` in the working folder. `check` uses Chrome: `$CHROME` if set,
otherwise Playwright's browsers, otherwise an installed Chrome or Chromium. `$CHROME_FLAGS` adds launch flags.

## A project

```json
{
  "title": "Example",
  "system": { "dir": "system", "namespace": "Ex", "install": "canvas/ds/ex" },
  "canvas": { "dir": "canvas" }
}
```

Every path is relative to the config's folder.

| Key | What it is |
|---|---|
| `title` | The canvas's name, when `canvas.json` has none |
| `system.dir` | The design system's folder (below). Leave `system` out for a canvas with none |
| `system.namespace` | The global the boards read the components from: `window.<namespace>` |
| `system.install` | Where the build installs the system for the boards: `tokens.css`, `tokens.json`, `components/bundle.js` and `components/bundle.css`. Left out, the system is built but not installed |
| `system.esbuild` | esbuild options laid over the kit's (`target: es2020`): a JSX factory, a target, minifying |
| `canvas.dir` | `canvas.json` and the boards |
| `canvas.artifact` | The claude.ai canvas that `sync` keeps in step with, if any |
| `comments`, `sync` | The comments file and the last sync's record (`comments.json` and `sync.json` by default) |

## A design system's folder

| Path | What it is |
|---|---|
| `tokens.json` | The tokens, in the [W3C Design Tokens format](https://www.designtokens.org/): `$value`, `$type` (on a token or its group), `$description`, aliases as `{group.key}`. A token's key is its CSS name. Each colour, shadow, dimension and font family becomes `--<key>`, and each typography token becomes the class `.<key>`. `$extensions["design-kit"]` holds the system's name, version and themes, and a type style's sample text |
| `src/index.jsx` | The components: a module whose default export is the namespace object (`{ Button, … }`). It imports React as usual. In the boards' bundle the import reads the page's React; the app's module leaves it as an import |
| `src/bundle.css` | The components' stylesheet. Every variable it uses must be a token, set in the stylesheet, or set inline by a component, or the build refuses it |
| `components/<Name>/` | One folder per component, holding three files:<br>`README.md` is its guide.<br>`<Name>.stories.js` holds its stories (below).<br>`<Name>.d.ts` holds its props. |
| `stories/` | What the stories share, and `preview.css`, the frame they render in |
| `fonts/` | Optional: `google.css` and its font files. A Google Fonts `css2` address in a board or stylesheet is then served from here, so nothing loads from Google |
| `README.md` | The system's rules: the first page of its Design system page |
| `dist/` | What the build writes (leave it out of git), listed below |

The build writes these files to `dist/`:

- `tokens.css`.
- `bundle.js`, which puts the namespace on `window.<namespace>` for a page that has React.
- `bundle.css`.
- `index.mjs`, the same components as an ES module that imports React, for an app.
- `index.d.ts`, every component's types.

It writes a file only when its content changes. It refuses three kinds of token error: an alias to no token, a key
used twice, and a token with no type. It also refuses an undefined CSS variable, and a component folder whose name
isn't in the namespace.

## Stories

A component's stories are in Component Story Format 3, the format Storybook reads.

- **The default export** is the file's meta. It can hold:
  - `title: 'Group/Name'`;
  - `component` and `subcomponents`;
  - `args` and `argTypes`;
  - `decorators`;
  - `parameters.height` (the preview's least height) and `parameters.wide`.
- **Each named export is a story**, shown in the order written:
  - `{ args }` renders the component with the file's args under the story's own. `{ ...Primary.args, disabled: true }` builds one story on another.
  - `{ render: (args) => … }` draws something else, such as several components or a layout.
  - `decorators` wrap a story, its own inside the file's.
  - A plain function is the older form, and still renders.

```js
export default {
  title: 'Actions/Button',
  component: Ex.Button,
  args: { children: 'Save' },
  argTypes: { variant: { control: 'select', options: ['primary', 'secondary', 'ghost'] } },
};
export const Primary = { args: { variant: 'primary' } };
export const Disabled = { args: { ...Primary.args, disabled: true } };
export const Variants = { render: () => row(/* every variant side by side */) };
```

**Controls.** On the Design system page, each story that renders from its args gets a control per arg. A change shows in
that story at once, and Reset puts it back.

| An arg with | Gets |
|---|---|
| `argTypes` `control: 'select'`, `'radio'` or `'inline-radio'`, with `options` | A choice |
| `control: 'boolean'`, `'text'`, `'number'` or `'range'`, or `'color'` | A switch, a field, or a colour picker |
| `control: false` | No control |
| No `argTypes`: a `true`/`false`, number or text value | A switch, a number field or a text field |

An arg that is an element or a function gets no control, and nor does a story whose `render` takes no args.

**Layout.** A story written as an object renders in a block of its own, as in Storybook, so a component keeps its own
width. A function story's elements sit straight in the system's frame (`.pv` in `stories/preview.css`).

**In Storybook.** The same files open in Storybook if its `preview.js` gives a story what the kit's preview page does:
`window.React`, the namespace on `window`, and the system's stylesheets.

## Boards

A board is one HTML file:

- **The template** is the markup inside `<x-dc>`. It can hold:
  - `{{path}}` holes;
  - `<sc-if value>` and `<sc-for list as>`, where `{{$index}}` is the position;
  - `<x-import component-from-global-scope="Ns.Name">` for a component of the design system;
  - `<helmet>` for what goes in the page's head.
- **The logic** is `<script type="text/x-dc" data-dc-script data-props='…'>`. It holds a `class Component extends DCLogic`,
  whose `renderVals()` returns what the template reads, and whose `setState` re-renders.
- **The tweaks** are the `data-props` JSON. Each prop has an editor (`enum`, `boolean`, `text`, `number`, `color`) and
  a default, and the viewer shows a control for each.

`canvas.json` lists the pages, each board's place, size and title, and the sticky notes. `example/canvas/Features.dc.html`
uses every part of the format, and `runtime/board.js` states each rule. A board loads `./support.js`, which the server
supplies: React and the runtime. Then it loads the design system the build installed.

## The viewer

- **Sidebar:** the canvas's pages, and the design system's Overview, Tokens and components by group.
- **The wall:** each page's boards in place. Drag or scroll to pan, pinch or ⌘ + scroll to zoom. `0` fits the page
  and `1` zooms to 100%.
- **Board, full window:** its tweaks and comments beside it, at the canvas's width, the board's own, or a phone's.
  **Play** shows the board alone, and its links move between boards.
- **Editing**, saved to `canvas.json` as you go:
  - drag a board by its title, or resize it from its corner;
  - double-click a title to rename the board;
  - `N` adds a sticky note;
  - ⌘Z / ⌘⇧Z undo and redo.
- **Comments:** press `C` and click a board or the canvas, or comment on a whole board. Comments are signed with
  `git config user.name`.
- **The Design system page:** the README, the tokens drawn from their values, and each component's stories rendered
  live, with controls for their args. Each component also shows its guide, its props, and the boards that use it.
- **Live:** a change on disk shows at once in every window. That includes a board, `canvas.json`, a token, a component
  or a story. If the system fails to build, its page says why and the boards keep the last good build.

## Keeping in step with claude.ai

The `.dc.html` format is the one claude.ai's Design canvas reads, and the build also writes `tokens.json` in the
format claude.ai's design systems keep. So a canvas can live in a repository and on claude.ai at once. claude.ai has no
command line, so Claude reads and publishes the canvas with its Artifact tool, and `design-kit sync` does the rest:

- **Pull:** save every `project/` file of the canvas's latest version, then run
  `design-kit sync pull <folder>/project --version <v>`.
  - A file changed only there is taken, and a file changed only here is kept.
  - `canvas.json` is merged entry by entry.
  - A change both sides made stops the pull, with nothing written, until `--theirs` or `--ours` decides.
- **Publish:** run `design-kit sync stage <folder>`. It copies what changed here under `<folder>/project/` and prints the
  Artifact call's `root`, `file_path` and `files`. After publishing, run `design-kit sync record --version <v>`.
- **Status:** `design-kit sync status` says what changed here since the last sync.

This project is not affiliated with Anthropic. The runtime is its own implementation of the format.

## As a library

`import { … } from 'design-kit'` gives what the commands are made of, for a project's own scripts and checks:

| Area | What it provides |
|---|---|
| Configs | `loadConfig` and `findConfig` |
| Server | `start({ config, port })`, which resolves once the first build is done, and `createApp` |
| Build | `build`, `write` and `differs` |
| Tokens | `readTokens`, `tokensCss` and `claudeTokens` |
| Stories | `loadStories`, and `storyNames`, `storyTitle`, `storyArgs`, `storyElement` and `storyControls`, which render a story as the kit does, for a project's own tests |
| Headless checks | `check`, `browser` (a small DevTools client: `open`, `evaluate`, `send`, `log`) and `findChrome` |
| Sync | `sync` |

## Developing

`npm test` runs the suite (`node:test`) on copies of `example/`:

- the config and the build;
- the server's API, edits, comments, live events and fonts;
- the sync;
- the board check and the viewer, driven in headless Chrome. These are skipped when no Chrome is found.

Node 22 or later.

To release:
1. Raise `version` in `package.json` and run `npm pack`.
2. Attach the `.tgz` to a GitHub release tagged `v<version>`.

## Licence

MIT. React, in `vendor/react/`, is MIT too.
