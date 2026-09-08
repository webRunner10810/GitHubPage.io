/* Speaker splitting and segment merging — the two transforms every saved
   transcript goes through. Both are pure, so they test directly. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignSpeakers, mergeSegments } from '../../js/asr.js';

const seg = (start, end, text, speaker = null) => ({ id: `${start}`, start, end, text, speaker });

describe('assignSpeakers', () => {
  it('keeps one speaker when phrases run together', () => {
    const out = assignSpeakers([
      seg(0, 2000, 'One.'),
      seg(2200, 4000, 'Two.'),
      seg(4300, 6000, 'Three.'),
    ], 1500);
    assert.deepEqual(out.map((s) => s.speaker), ['S1', 'S1', 'S1']);
  });

  it('switches speaker after a gap longer than the threshold', () => {
    const out = assignSpeakers([
      seg(0, 2000, 'Question?'),
      seg(4000, 6000, 'Answer.'),
      seg(6200, 7000, 'And more.'),
      seg(10_000, 11_000, 'Back to the first.'),
    ], 1500);
    assert.deepEqual(out.map((s) => s.speaker), ['S1', 'S2', 'S2', 'S1']);
  });

  it('respects a custom gap threshold', () => {
    const segments = [seg(0, 1000, 'A.'), seg(3000, 4000, 'B.')];
    assert.deepEqual(assignSpeakers(segments, 5000).map((s) => s.speaker), ['S1', 'S1']);
    assert.deepEqual(assignSpeakers(segments, 1000).map((s) => s.speaker), ['S1', 'S2']);
  });

  it('handles an empty transcript', () => {
    assert.deepEqual(assignSpeakers([], 1500), []);
  });

  it('does not mutate its input', () => {
    const input = [seg(0, 1000, 'A.')];
    assignSpeakers(input, 1500);
    assert.equal(input[0].speaker, null);
  });
});

describe('mergeSegments', () => {
  it('joins adjacent phrases from the same speaker', () => {
    const out = mergeSegments([
      seg(0, 2000, 'This is the first half', 'S1'),
      seg(2300, 4000, 'and this is the second.', 'S1'),
    ], 900);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'This is the first half and this is the second.');
    assert.equal(out[0].start, 0);
    assert.equal(out[0].end, 4000);
  });

  it('does not join across a speaker change', () => {
    const out = mergeSegments([
      seg(0, 2000, 'Mine.', 'S1'),
      seg(2100, 4000, 'Yours.', 'S2'),
    ], 900);
    assert.equal(out.length, 2);
  });

  it('does not join across a long pause', () => {
    const out = mergeSegments([
      seg(0, 2000, 'Before.', 'S1'),
      seg(9000, 11_000, 'After.', 'S1'),
    ], 900);
    assert.equal(out.length, 2);
  });

  it('stops merging before a paragraph grows unreadable', () => {
    const long = 'word '.repeat(120).trim();
    const out = mergeSegments([
      seg(0, 2000, long, 'S1'),
      seg(2100, 4000, long, 'S1'),
    ], 900);
    assert.equal(out.length, 2);
  });

  it('does not mutate its input', () => {
    const input = [seg(0, 2000, 'A', 'S1'), seg(2100, 3000, 'B', 'S1')];
    mergeSegments(input, 900);
    assert.equal(input[0].text, 'A');
    assert.equal(input.length, 2);
  });
});
