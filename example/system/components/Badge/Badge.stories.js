import { h, Ex, row } from '../../stories/helpers.js';

export default {
  title: 'Status/Badge',
  component: Ex.Badge,
  args: { tone: 'neutral', children: 'Draft' },
  argTypes: { tone: { control: 'inline-radio', options: ['neutral', 'positive', 'warning'] } },
  parameters: { height: 64 },
};

export const Positive = { args: { tone: 'positive', children: 'Done' } };

export const Tones = {
  render: () => row(
    h(Ex.Badge, { tone: 'positive' }, 'Done'),
    h(Ex.Badge, { tone: 'warning' }, 'Due soon'),
    h(Ex.Badge, null, 'Draft')),
};

// A render that takes the args: the badge inside a line of text.
export const InText = {
  args: { tone: 'warning', children: 'Due soon' },
  render: (args) => h('p', { className: 'text-body', style: { margin: 0 } }, 'Onboarding checklist ', h(Ex.Badge, args)),
};
