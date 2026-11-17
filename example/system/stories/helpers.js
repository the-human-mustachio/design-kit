// What every story is built from. The page loads React and the design system's bundle (window.Ex) before any story.
export var React = window.React, h = React.createElement, Ex = window.Ex;
function box(className) { return function () { return h.apply(null, ['div', { className: className }].concat(Array.prototype.slice.call(arguments))); }; }
export var row = box('pv-row'), col = box('pv-col');
