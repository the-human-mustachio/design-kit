import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { KIT } from '../index.mjs';
import { writtenOrder, storyNames, storyTitle, storyArgs, storyElement, storyControls } from '../lib/stories.mjs';

const require = createRequire(path.join(KIT, 'package.json'));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const h = React.createElement;
const html = (meta, story, key = 'S') => renderToStaticMarkup(storyElement(React, meta, story, storyArgs(meta, story), key));
const Tag = ({ tone = 'none', children }) => h('b', { className: tone }, children);

test('which exports are stories, in CSF\'s order: __namedExportsOrder, else as written, then any other', () => {
  assert.deepEqual(writtenOrder('export const B = 1;\nexport function A() {}\nexport default {};\nexport let C;\nexport async function D() {}'), ['B', 'A', 'C', 'D']);
  const f = () => {};
  assert.deepEqual(storyNames({ default: {}, A: f, B: {}, C: f, D: 1, E: [], F: null }, ['C', 'A']), ['C', 'A', 'B']);
  assert.deepEqual(storyNames({ A: f, B: f, __namedExportsOrder: ['B', 'A'] }, ['A', 'B']), ['B', 'A']);
  assert.deepEqual(storyNames({ default: { excludeStories: /Data$/ }, Basic: {}, rowsData: {}, tableData: {} }), ['Basic']);
  assert.deepEqual(storyNames({ default: { includeStories: ['Basic'], excludeStories: ['Other'] }, Basic: {}, Other: {}, Third: {} }), ['Basic']);
});

test('a story\'s name and args', () => {
  assert.deepEqual([storyTitle('PrimaryButton', {}), storyTitle('with_icon', {}), storyTitle('X', { name: 'Named' })], ['Primary Button', 'with icon', 'Named']);
  assert.deepEqual(storyArgs({ args: { a: 1, b: 1 } }, { args: { b: 2, c: 3 } }), { a: 1, b: 2, c: 3 });
  const fn = () => null;
  fn.args = { a: 2 };
  assert.deepEqual(storyArgs({ args: { a: 1 } }, fn), { a: 2 });
});

test('a story renders: the file\'s component with its args, its own render, or the older function', () => {
  const meta = { component: Tag, args: { children: 'Hi' } };
  assert.equal(html(meta, { args: { tone: 'warm' } }), '<b class="warm">Hi</b>');
  assert.equal(html(meta, {}), '<b class="none">Hi</b>');
  assert.equal(html(meta, { args: { tone: 'x' }, render: (args, ctx) => h('i', null, args.tone + ' ' + ctx.name) }, 'InText'), '<i>x In Text</i>');
  assert.equal(html({ ...meta, render: (args) => h('u', null, args.children) }, {}), '<u>Hi</u>');
  assert.equal(html({}, () => h('s', null, 'old')), '<s>old</s>');
  // A render may use hooks: it runs inside a component.
  assert.equal(html({}, { render: () => h('p', null, React.useState('state')[0]) }), '<p>state</p>');
  assert.throws(() => storyElement(React, {}, { args: {} }, {}), /no render, and the file names no component/);
});

test('decorators wrap a story: its own inside the file\'s', () => {
  const wrap = (cls) => (Story, ctx) => h('div', { className: cls + ' ' + ctx.title }, h(Story));
  assert.equal(html({ title: 'T', component: Tag, args: { children: 'x' }, decorators: [wrap('file')] }, { decorators: [wrap('own')] }),
    '<div class="file T"><div class="own T"><b class="none">x</b></div></div>');
});

test('controls: from argTypes, else from each arg\'s value; none for a render that takes no args', () => {
  const meta = {
    args: { tone: 'a', on: true, n: 3, label: 'x', node: h('b'), fn: () => {}, nothing: undefined },
    argTypes: {
      tone: { control: 'inline-radio', options: ['a', 'b'] },
      size: { control: { type: 'range', min: 1, max: 9, step: 2 } },
      hidden: { control: false },
      kind: { options: ['x', 'y'] },
      rich: { control: 'select', options: [{ a: 1 }] },
      when: { control: 'date' },
      label: { control: 'color' },
    },
  };
  assert.deepEqual(storyControls(meta, {}, storyArgs(meta, {})), [
    { name: 'tone', editor: 'enum', options: ['a', 'b'] },
    { name: 'on', editor: 'boolean' },
    { name: 'n', editor: 'number' },
    { name: 'label', editor: 'color' },
    { name: 'size', editor: 'number', min: 1, max: 9, step: 2 },
    { name: 'kind', editor: 'enum', options: ['x', 'y'] },
  ]);
  assert.deepEqual(storyControls(meta, { render: () => null }, {}), []);
  assert.deepEqual(storyControls(meta, () => null, {}), []);
  assert.deepEqual(storyControls({}, { render: (args) => null }, { on: false }), [{ name: 'on', editor: 'boolean' }]);
});
