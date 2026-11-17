// The Example design system's components, exported as one object: the namespace, Ex. They import React as any module
// does; the kit's build reads it from the page (window.React) for the boards' bundle, and leaves the import to the app
// in dist/index.mjs.
import React, { useState } from 'react';

const cx = (...a) => a.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Button
export function Button({ variant = 'secondary', size = 'md', href, disabled = false, onClick, children }) {
  const className = cx('ex-btn', 'ex-btn--' + variant, size === 'sm' && 'ex-btn--sm');
  if (href && !disabled) return <a className={className} href={href}>{children}</a>;
  return <button type="button" className={className} disabled={disabled} onClick={onClick}>{children}</button>;
}

// ---------------------------------------------------------------- Badge
export function Badge({ tone = 'neutral', children }) {
  return <span className={cx('ex-badge', 'ex-badge--' + tone)}>{children}</span>;
}

// ---------------------------------------------------------------- Card
// A titled box. Collapsible, its header's button hides and shows the body; the card keeps that state itself.
export function Card({ title, actions, collapsible = false, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = !collapsible || open;
  return (
    <section className="ex-card" aria-label={title || undefined}>
      {title != null && (
        <CardHeader title={title} actions={actions} open={collapsible ? open : undefined} onToggle={collapsible ? () => setOpen(!open) : undefined} />
      )}
      {shown && <div className="ex-card__body">{children}</div>}
    </section>
  );
}

// A card's top line: its title, what it offers on the right, and, when the card collapses, the button that does it.
export function CardHeader({ title, actions, open, onToggle }) {
  return (
    <header className="ex-card__head">
      <h2 className="ex-card__title text-body">{title}</h2>
      {actions && <div className="ex-card__actions">{actions}</div>}
      {onToggle && (
        <button type="button" className="ex-card__toggle" aria-expanded={!!open} onClick={onToggle}>{open ? 'Hide' : 'Show'}</button>
      )}
    </header>
  );
}

export default { Button, Badge, Card, CardHeader };
