/* Shared UI primitives: toasts, bottom sheets, confirm/prompt dialogs. */

import { $, el, haptic, icon } from './util.js';

export function toast(message, kind = '', ms = 3200) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const node = el('div', { class: `toast ${kind}`.trim() }, message);
  stack.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease, transform .25s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

let closeCurrentSheet = null;

/**
 * Open a bottom sheet. `render(close)` returns the sheet's contents.
 * Resolves when the sheet closes.
 */
export function sheet(render, { dismissible = true } = {}) {
  closeCurrentSheet?.();
  const host = $('#sheet-host');
  return new Promise((resolve) => {
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      closeCurrentSheet = null;
      host.hidden = true;
      host.replaceChildren();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) close(undefined);
    };

    const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'sheet-handle' }),
      render(close));

    host.replaceChildren(panel);
    host.hidden = false;
    host.onclick = (e) => {
      if (e.target === host && dismissible) close(undefined);
    };
    document.addEventListener('keydown', onKey);
    closeCurrentSheet = () => close(undefined);
    haptic(8);

    // Focus the first control so keyboards and screen readers land inside.
    setTimeout(() => panel.querySelector('input, textarea, button')?.focus(), 60);
  });
}

export function confirmSheet({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return sheet((close) => el('div', { class: 'stack' },
    el('h2', {}, title),
    body ? el('p', { class: 'muted small' }, body) : null,
    el('div', { class: 'stack', style: 'margin-top:6px' },
      el('button', {
        class: `btn btn-block ${danger ? 'btn-danger' : 'btn-primary'}`,
        type: 'button',
        onclick: () => close(true),
      }, confirmLabel),
      el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close(false) }, 'Cancel'))));
}

export function promptSheet({ title, label, value = '', placeholder = '', multiline = false, confirmLabel = 'Save' }) {
  return sheet((close) => {
    const input = multiline
      ? el('textarea', { class: 'textarea', placeholder })
      : el('input', { class: 'input', type: 'text', placeholder, enterkeyhint: 'done' });
    input.value = value;
    const submit = () => close(input.value.trim());
    if (!multiline) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    }
    return el('div', { class: 'stack' },
      el('h2', {}, title),
      el('div', { class: 'field' }, label ? el('label', {}, label) : null, input),
      el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: submit }, confirmLabel),
      el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close(undefined) }, 'Cancel'));
  });
}

export function emptyState(iconName, title, body, action) {
  return el('div', { class: 'empty' },
    icon(iconName),
    el('h3', { style: 'margin-bottom:6px' }, title),
    el('p', { class: 'small', style: 'margin:0 0 16px' }, body),
    action || null);
}

export function banner(message, { kind = '', iconName = 'warn' } = {}) {
  return el('div', { class: `banner ${kind}`.trim() }, icon(iconName), el('div', {}, message));
}

export function spinnerRow(label) {
  return el('div', { class: 'row' }, el('div', { class: 'spinner' }), el('span', { class: 'small muted' }, label));
}
