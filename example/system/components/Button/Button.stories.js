import { h, Ex, row } from '../../stories/helpers.js';

export default {
  title: 'Actions/Button',
  component: Ex.Button,
  args: { children: 'Save', variant: 'secondary', size: 'md', disabled: false },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'ghost'] },
    size: { control: 'inline-radio', options: ['md', 'sm'] },
  },
  parameters: { height: 72 },
};

export const Primary = { args: { variant: 'primary' } };

export const Disabled = { args: { ...Primary.args, disabled: true } };

export const Variants = {
  render: () => row(
    h(Ex.Button, { variant: 'primary' }, 'Save'),
    h(Ex.Button, null, 'Cancel'),
    h(Ex.Button, { variant: 'ghost' }, 'Skip'),
    h(Ex.Button, { href: '#' }, 'A link')),
};
