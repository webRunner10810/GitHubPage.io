/* normalizeAnalysis is the boundary between whatever the model returned and
   what the views render, so it has to survive missing fields, wrong types and
   junk without the UI ever null-checking. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeAnalysis } from '../../js/ai.js';

describe('normalizeAnalysis', () => {
  it('maps a well-formed response onto the render shape', () => {
    const out = normalizeAnalysis({
      title: 'Billing rollout',
      summary: 'We agreed a staged rollout.',
      key_points: ['Ship before quarter end'],
      decisions: ['Staged rollout at five percent'],
      action_items: [{ task: 'Write the plan', owner: 'Alex', due: 'Friday', priority: 'high' }],
      open_questions: ['Is the migration blocking?'],
      topics: ['Billing'],
      sentiment: { overall: 'positive', note: 'Aligned.' },
      follow_up_email: 'Hi team —',
    }, { provider: 'anthropic', model: 'claude-opus-5' });

    assert.equal(out.title, 'Billing rollout');
    assert.deepEqual(out.keyPoints, ['Ship before quarter end']);
    assert.equal(out.actionItems[0].owner, 'Alex');
    assert.equal(out.actionItems[0].done, false);
    assert.equal(out.sentiment.overall, 'positive');
    assert.equal(out.provider, 'anthropic');
    assert.equal(out.model, 'claude-opus-5');
    assert.ok(out.generatedAt > 0);
  });

  it('fills in every field when given nothing at all', () => {
    const out = normalizeAnalysis(undefined);
    assert.equal(out.title, '');
    assert.equal(out.summary, '');
    assert.deepEqual(out.keyPoints, []);
    assert.deepEqual(out.decisions, []);
    assert.deepEqual(out.actionItems, []);
    assert.deepEqual(out.openQuestions, []);
    assert.deepEqual(out.topics, []);
    assert.equal(out.sentiment.overall, 'neutral');
    assert.equal(out.followUpEmail, '');
    assert.equal(out.provider, 'local');
  });

  it('drops list entries that are not usable', () => {
    const out = normalizeAnalysis({
      key_points: ['real', null, '', undefined],
      action_items: [
        { task: 'Keep me', owner: '', due: '', priority: 'nonsense' },
        { task: '   ', owner: 'Nobody' },
        { owner: 'No task at all' },
      ],
    });
    assert.deepEqual(out.keyPoints, ['real']);
    assert.equal(out.actionItems.length, 1);
    assert.equal(out.actionItems[0].task, 'Keep me');
  });

  it('defaults an unknown priority to medium and a blank owner to Unassigned', () => {
    const out = normalizeAnalysis({
      action_items: [{ task: 'Do it', owner: '   ', due: '', priority: 'catastrophic' }],
    });
    assert.equal(out.actionItems[0].priority, 'medium');
    assert.equal(out.actionItems[0].owner, 'Unassigned');
  });

  it('rejects an out-of-range sentiment', () => {
    assert.equal(normalizeAnalysis({ sentiment: { overall: 'ecstatic' } }).sentiment.overall, 'neutral');
    assert.equal(normalizeAnalysis({ sentiment: { overall: 'tense' } }).sentiment.overall, 'tense');
  });

  it('accepts already-normalised camelCase input, so re-normalising is safe', () => {
    const once = normalizeAnalysis({
      key_points: ['a'],
      action_items: [{ task: 't', owner: 'o', due: 'd', priority: 'low' }],
      open_questions: ['q'],
      follow_up_email: 'e',
    });
    const twice = normalizeAnalysis(once);
    assert.deepEqual(twice.keyPoints, ['a']);
    assert.deepEqual(twice.openQuestions, ['q']);
    assert.equal(twice.followUpEmail, 'e');
    assert.equal(twice.actionItems[0].task, 't');
  });

  it('preserves the done flag through a round trip', () => {
    const out = normalizeAnalysis({
      action_items: [{ task: 'Finished thing', owner: 'A', due: '', priority: 'low', done: true }],
    });
    assert.equal(out.actionItems[0].done, true);
  });

  it('survives a list arriving as a string instead of an array', () => {
    const out = normalizeAnalysis({ key_points: 'not a list', topics: 42 });
    assert.deepEqual(out.keyPoints, []);
    assert.deepEqual(out.topics, []);
  });
});
