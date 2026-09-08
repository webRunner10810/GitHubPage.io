/* App shell: hash router, top bar, service worker registration. */

import { $, el, icon } from './util.js';
import { confirmSheet, toast } from './ui.js';
import * as recordView from './views/record.js';
import * as libraryView from './views/library.js';
import * as meetingView from './views/meeting.js';
import * as settingsView from './views/settings.js';

const ROUTES = [
  { pattern: /^#\/record$/, view: recordView, tab: 'record', title: 'Summary' },
  { pattern: /^#\/library$/, view: libraryView, tab: 'library', title: 'Library' },
  { pattern: /^#\/settings$/, view: settingsView, tab: 'settings', title: 'Settings' },
  { pattern: /^#\/meeting\/(?<id>[^/]+)$/, view: meetingView, tab: 'library', title: 'Recording' },
];

const viewRoot = $('#view');
const topbarTitle = $('#topbar-title');
const topbarActions = $('#topbar-actions');
const backBtn = $('#back-btn');

let unmount = null;
let currentHash = '';

const ctx = {
  go(hash, { reload = false } = {}) {
    if (reload && location.hash === hash) {
      currentHash = '';
      route();
      return;
    }
    location.hash = hash;
  },
  setTopbar({ title, back = null, actions = [] } = {}) {
    if (title !== undefined) topbarTitle.textContent = title;
    backBtn.hidden = !back;
    backBtn.onclick = back ? () => { location.hash = back; } : null;
    topbarActions.replaceChildren(...actions.map((action) => el('button', {
      type: 'button',
      'aria-label': action.label,
      class: `icon-btn${action.active ? ' starred' : ''}`,
      onclick: action.onClick,
    }, icon(action.icon))));
  },
};

function syncTabs(tab) {
  document.querySelectorAll('.tab').forEach((node) => {
    if (node.dataset.tab === tab) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
}

function route() {
  const hash = location.hash || '#/record';
  if (hash === currentHash) return;

  const match = ROUTES.map((r) => ({ r, m: hash.match(r.pattern) })).find(({ m }) => m);
  if (!match) {
    location.hash = '#/record';
    return;
  }

  // Leaving the Record tab mid-recording is allowed (capture keeps running),
  // but a full reload would lose it, so only guard the destructive case.
  const { r, m } = match;
  currentHash = hash;

  try {
    unmount?.();
  } catch { /* a failing teardown must not block navigation */ }
  unmount = null;

  ctx.setTopbar({ title: r.title, back: null, actions: [] });
  syncTabs(r.tab);
  viewRoot.scrollTop = 0;
  window.scrollTo(0, 0);

  try {
    unmount = r.view.mount(viewRoot, ctx, m.groups || {}) || null;
  } catch (err) {
    console.error(err);
    viewRoot.replaceChildren(el('div', { class: 'empty' },
      el('h3', {}, 'Something went wrong'),
      el('p', { class: 'small' }, err?.message || String(err))));
  }
  viewRoot.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);

/* Warn before a reload or close would kill a live recording. */
window.addEventListener('beforeunload', (e) => {
  if (recordView.isRecording()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* Keep the library and detail views fresh when data changes elsewhere. */
window.addEventListener('summary:analysis-error', (e) => {
  if (location.hash.includes(e.detail.id)) return; // the detail view shows it
  toast(`Analysis failed: ${e.detail.message}`, 'err');
});

/* ------------------------------------------------------- service worker */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', async () => {
          if (installing.state !== 'installed' || !navigator.serviceWorker.controller) return;
          if (recordView.isRecording()) return; // never interrupt a recording
          const ok = await confirmSheet({
            title: 'Update available',
            body: 'A newer version of Summary has been downloaded.',
            confirmLabel: 'Reload now',
          });
          if (ok) {
            installing.postMessage('skip-waiting');
            location.reload();
          }
        });
      });
    }).catch(() => { /* offline support is optional */ });
  });
}

/* --------------------------------------------------------- install hint */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const bar = el('div', { class: 'toast interactive' },
    el('div', { class: 'row-between' },
      el('span', {}, 'Install Summary for offline use'),
      el('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        onclick: () => {
          bar.remove();
          installPrompt?.prompt();
          installPrompt = null;
        },
      }, 'Install')));
  $('#toast-stack').append(bar);
  setTimeout(() => bar.remove(), 12_000);
});

if (!location.hash) location.hash = '#/record';
route();
