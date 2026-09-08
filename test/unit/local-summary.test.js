/* The on-device fallback. It runs whenever there is no API key, so it has to
   produce something honest rather than something impressive. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeLocally } from '../../js/local-summary.js';

const meeting = (segments, extra = {}) => ({
  id: 'm1',
  title: '',
  createdAt: Date.now(),
  durationMs: segments.length * 12_000,
  speakers: {},
  segments: segments.map((text, i) => ({
    id: `s${i}`,
    start: i * 12_000,
    end: i * 12_000 + 8000,
    speaker: i % 2 ? 'S2' : 'S1',
    text,
  })),
  ...extra,
});

describe('analyzeLocally', () => {
  it('says so plainly when there is nothing to summarise', () => {
    const out = analyzeLocally(meeting([]));
    assert.match(out.summary, /No speech was transcribed/);
    assert.deepEqual(out.actionItems, []);
    assert.equal(out.provider, 'local');
  });

  it('detects a commitment as an action item with its deadline', () => {
    const out = analyzeLocally(meeting([
      'The billing migration is the main topic for the billing team today.',
      "I'll write up the billing rollout plan by Friday and share it with everyone.",
    ]));
    assert.ok(out.actionItems.length >= 1, 'expected an action item');
    const item = out.actionItems.find((a) => /rollout plan/.test(a.task));
    assert.ok(item, 'expected the rollout plan commitment');
    assert.match(item.due, /friday/i);
  });

  it('detects a settled decision separately from discussion', () => {
    const out = analyzeLocally(meeting([
      'We were discussing the billing rewrite and the billing rollout at length.',
      'We decided to go with the staged billing rollout starting at five percent.',
    ]));
    assert.ok(out.decisions.some((d) => /decided/i.test(d)), 'expected a decision');
  });

  it('collects unresolved questions', () => {
    const out = analyzeLocally(meeting([
      'The invoicing migration keeps coming up in the invoicing discussion.',
      'Is the invoicing migration blocking anything urgent on the data side?',
    ]));
    assert.ok(out.openQuestions.some((q) => /invoicing migration/i.test(q)));
  });

  it('marks urgent commitments as high priority', () => {
    const out = analyzeLocally(meeting([
      'The urgent outage work needs an urgent owner for the outage today.',
      "I'll fix the outage immediately, this is a critical blocker.",
    ]));
    const urgent = out.actionItems.find((a) => /outage/i.test(a.task));
    assert.ok(urgent);
    assert.equal(urgent.priority, 'high');
  });

  it('does not offer a title built from words said only once', () => {
    const out = analyzeLocally(meeting([
      'Alpha beta gamma delta epsilon zeta eta theta.',
    ]));
    assert.equal(out.title, '', 'a one-off word salad should not become a title');
  });

  it('titles the recording from words that actually recur', () => {
    const out = analyzeLocally(meeting([
      'The billing rewrite is the topic, specifically the billing rollout schedule.',
      'Billing rollout timing matters more than the rewrite scope for this rollout.',
    ]));
    assert.match(out.title.toLowerCase(), /billing|rollout/);
  });

  it('always labels itself as on-device so it is never mistaken for the AI pass', () => {
    const out = analyzeLocally(meeting(['Some ordinary discussion about the topic at hand.']));
    assert.equal(out.provider, 'local');
    assert.match(out.summary, /on-device/i);
  });

  it('reports the number of detected speakers', () => {
    const out = analyzeLocally(meeting([
      'First person speaking about the project and the project timeline.',
      'Second person replying about the project timeline and the project scope.',
    ]));
    assert.match(out.summary, /2 detected speakers/);
  });
});
