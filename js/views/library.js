/* Library view — search, browse and manage saved recordings. */

import { debounce, el, fmtDate, fmtDuration, highlight, icon } from '../util.js';
import { emptyState } from '../ui.js';
import { listMeetings } from '../db.js';
import { displayTitle } from '../export.js';

function matches(meeting, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [
    displayTitle(meeting),
    meeting.analysis?.summary,
    ...(meeting.analysis?.topics || []),
    ...(meeting.analysis?.keyPoints || []),
    ...(meeting.analysis?.actionItems || []).map((a) => a.task),
    ...(meeting.segments || []).map((s) => s.text),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function snippetFor(meeting, query) {
  const text = meeting.analysis?.summary
    || (meeting.segments || []).map((s) => s.text).join(' ')
    || 'No transcript captured.';
  if (!query) return text.slice(0, 220);
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 220);
  const from = Math.max(0, at - 60);
  return `${from > 0 ? '…' : ''}${text.slice(from, from + 220)}`;
}

function card(meeting, query, go) {
  const a = meeting.analysis;
  const openCount = (a?.actionItems || []).filter((item) => !item.done).length;

  const meta = [
    el('span', { class: 'pill' }, icon('clock'), fmtDuration(meeting.durationMs)),
    meeting.source === 'call' ? el('span', { class: 'pill' }, 'Call') : null,
    openCount ? el('span', { class: 'pill pill-accent' }, `${openCount} action${openCount === 1 ? '' : 's'}`) : null,
    a ? null : el('span', { class: 'pill' }, 'Not analysed'),
    a?.provider === 'local' ? el('span', { class: 'pill' }, 'On-device') : null,
  ].filter(Boolean);

  return el('button', {
    class: 'meeting-card',
    type: 'button',
    onclick: () => go(`#/meeting/${meeting.id}`),
  },
  el('div', { class: 'row-between' },
    el('h3', { class: 'truncate', html: highlight(displayTitle(meeting), query) }),
    meeting.starred ? el('span', { class: 'faint', style: 'color:#ffcf5c' }, '★') : null),
  el('div', { class: 'tiny faint' }, fmtDate(meeting.createdAt)),
  el('p', { class: 'snippet', html: highlight(snippetFor(meeting, query), query) }),
  el('div', { class: 'meta' }, ...meta));
}

export function mount(root, ctx) {
  let query = '';
  let starredOnly = false;
  let all = [];

  const searchInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search titles, summaries and transcripts',
    enterkeyhint: 'search',
    'aria-label': 'Search recordings',
  });
  const searchbar = el('div', { class: 'searchbar' }, icon('search'), searchInput);

  const filterRow = el('div', { class: 'row', style: 'margin-bottom:12px;gap:8px;flex-wrap:wrap' });
  const list = el('div', { class: 'stack' });

  function renderFilters() {
    filterRow.replaceChildren(
      el('button', {
        class: `mode-chip${starredOnly ? '' : ''}`,
        type: 'button',
        style: 'flex:0 0 auto;padding:8px 14px',
        'aria-pressed': String(starredOnly),
        onclick: () => { starredOnly = !starredOnly; renderFilters(); render(); },
      }, starredOnly ? '★ Starred only' : '☆ Starred only'),
      el('span', { class: 'tiny faint grow', style: 'text-align:right' },
        `${all.length} recording${all.length === 1 ? '' : 's'}`),
    );
  }

  function render() {
    const visible = all
      .filter((m) => (!starredOnly || m.starred))
      .filter((m) => matches(m, query));

    if (!all.length) {
      list.replaceChildren(emptyState(
        'mic',
        'No recordings yet',
        'Start a recording and it will show up here with its transcript and summary.',
        el('a', { class: 'btn btn-primary', href: '#/record' }, 'Start recording'),
      ));
      return;
    }
    if (!visible.length) {
      list.replaceChildren(emptyState('search', 'Nothing matched', 'Try a different word, or clear the filters.'));
      return;
    }
    list.replaceChildren(...visible.map((m) => card(m, query, ctx.go)));
  }

  searchInput.addEventListener('input', debounce(() => {
    query = searchInput.value.trim();
    render();
  }, 160));

  async function load() {
    all = await listMeetings();
    renderFilters();
    render();
  }

  const onUpdated = () => load();
  window.addEventListener('summary:analysis-done', onUpdated);
  window.addEventListener('summary:meeting-changed', onUpdated);

  root.replaceChildren(el('div', {}, searchbar, filterRow, list));
  load();

  return () => {
    window.removeEventListener('summary:analysis-done', onUpdated);
    window.removeEventListener('summary:meeting-changed', onUpdated);
  };
}
