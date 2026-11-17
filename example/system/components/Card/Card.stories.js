import { h, Ex } from '../../stories/helpers.js';

const body = (text) => h('p', { className: 'text-body', style: { margin: 0 } }, text);

export default {
  title: 'Layout/Card',
  component: Ex.Card,
  subcomponents: { CardHeader: Ex.CardHeader },
  args: { title: 'This week', collapsible: false, defaultOpen: true, children: body('Three tasks are due before Friday.') },
  // Cards fill their column: each story sits in one 640px wide.
  decorators: [(Story) => h('div', { style: { maxWidth: 640 } }, h(Story))],
  parameters: { height: 280, wide: true },
};

export const Basic = { args: { actions: h(Ex.Button, { size: 'sm', variant: 'ghost' }, 'See all') } };

export const Collapsible = { args: { title: 'Details', collapsible: true, children: body('Hide this card from its header.') } };
