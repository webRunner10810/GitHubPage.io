/* Export is the format people actually take away, so its structure is
   load-bearing: headings other tools key off, and checkbox state that has to
   survive the round trip. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { baseFilename, displayTitle, meetingTitle, toJson, toMarkdown, toPlainText } from '../../js/export.js';

const base = {
  id: 'abc',
  title: '',
  createdAt: new Date('2026-03-04T09:30:00Z').getTime(),
  durationMs: 754_000,
  source: 'call',
  speakers: { S1: 'Alex', S2: 'Sam' },
  segments: [
    { id: 's1', start: 2000, end: 9000, speaker: 'S1', text: 'Opening remarks.' },
    { id: 's2', start: 12_000, end: 20_000, speaker: 'S2', text: 'A reply.' },
  ],
  analysis: {
    title: 'Billing rollout',
    summary: 'A staged rollout was agreed.',
    keyPoints: ['Ship before quarter end'],
    decisions: ['Staged rollout at five percent'],
    actionItems: [
      { id: 'a0', task: 'Write the plan', owner: 'Alex', due: 'Friday', priority: 'high', done: true },
      { id: 'a1', task: 'Check the migration', owner: 'Unassigned', due: '', priority: 'low', done: false },
    ],
    openQuestions: ['Is the migration blocking?'],
    topics: ['Billing', 'Rollout'],
    sentiment: { overall: 'positive', note: 'Aligned.' },
    followUpEmail: 'Hi team —',
    provider: 'anthropic',
    model: 'claude-opus-5',
    generatedAt: Date.now(),
  },
};

describe('titles', () => {
  it('prefers a user title over the generated one', () => {
    assert.equal(displayTitle({ ...base, title: 'My name for it' }), 'My name for it');
    assert.equal(meetingTitle({ ...base, title: 'My name for it' }), 'My name for it');
  });

  it('falls back to the analysis title', () => {
    assert.equal(displayTitle(base), 'Billing rollout');
  });

  it('names an unanalysed recording without pretending otherwise', () => {
    const bare = { ...base, analysis: null };
    assert.equal(displayTitle(bare), 'Untitled recording');
    assert.match(meetingTitle(bare), /^Recording — /);
  });
});

describe('toMarkdown', () => {
  const md = toMarkdown(base);

  it('leads with the title and the recording metadata', () => {
    assert.ok(md.startsWith('# Billing rollout'));
    assert.match(md, /Phone call/);
    assert.match(md, /12:34/);
  });

  it('emits every populated section', () => {
    for (const heading of ['## Summary', '## Key points', '## Decisions', '## Action items', '## Open questions', '## Transcript']) {
      assert.match(md, new RegExp(heading.replace(/[#]/g, '\\#')), `missing ${heading}`);
    }
  });

  it('renders action items as checkboxes reflecting their state', () => {
    assert.match(md, /- \[x\] Write the plan/);
    assert.match(md, /- \[ \] Check the migration/);
  });

  it('attributes transcript lines to named speakers with timestamps', () => {
    assert.match(md, /\[00:02\] Alex:/);
    assert.match(md, /\[00:12\] Sam:/);
  });

  it('can omit the transcript for a share-sized export', () => {
    const short = toMarkdown(base, { includeTranscript: false });
    assert.doesNotMatch(short, /## Transcript/);
    assert.match(short, /## Summary/);
  });

  it('credits the model when the analysis came from the API', () => {
    assert.match(md, /claude-opus-5/);
  });

  it('says on-device when it did not', () => {
    const local = toMarkdown({ ...base, analysis: { ...base.analysis, provider: 'local', model: 'on-device' } });
    assert.match(local, /on-device analysis/i);
  });

  it('handles a recording with no analysis at all', () => {
    const md2 = toMarkdown({ ...base, analysis: null });
    assert.match(md2, /## Transcript/);
    assert.doesNotMatch(md2, /## Summary/);
  });
});

describe('toPlainText', () => {
  it('strips the markdown syntax but keeps the content', () => {
    const txt = toPlainText(base);
    assert.doesNotMatch(txt, /^#/m);
    assert.doesNotMatch(txt, /\*\*/);
    assert.match(txt, /Billing rollout/);
    assert.match(txt, /Write the plan/);
  });
});

describe('toJson', () => {
  it('round-trips the whole record', () => {
    const parsed = JSON.parse(toJson(base));
    assert.equal(parsed.id, 'abc');
    assert.equal(parsed.segments.length, 2);
    assert.equal(parsed.analysis.actionItems[0].done, true);
  });
});

describe('baseFilename', () => {
  it('is date-prefixed and filesystem safe', () => {
    const name = baseFilename(base);
    assert.match(name, /^\d{4}-\d{2}-\d{2}-/);
    assert.match(name, /^[a-z0-9-]+$/);
  });

  it('never produces an empty name', () => {
    const name = baseFilename({ ...base, title: '!!! ???', analysis: null });
    assert.ok(name.length > 10);
    assert.match(name, /^[a-z0-9-]+$/);
  });
});
