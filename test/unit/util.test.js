/* Formatting helpers. These appear on nearly every screen, and the edge cases
   (an hour boundary, a zero, a search term containing regex metacharacters)
   are exactly the ones that reach users. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { escapeHtml, fmtBytes, fmtClock, fmtDuration, highlight, sentencesOf } from '../../js/util.js';

describe('fmtDuration', () => {
  it('formats minutes and seconds', () => {
    assert.equal(fmtDuration(0), '0:00');
    assert.equal(fmtDuration(65_000), '1:05');
    assert.equal(fmtDuration(599_000), '9:59');
  });

  it('adds an hours field once it is needed', () => {
    assert.equal(fmtDuration(3_725_000), '1:02:05');
    assert.equal(fmtDuration(3_600_000), '1:00:00');
  });

  it('treats missing or negative input as zero', () => {
    assert.equal(fmtDuration(undefined), '0:00');
    assert.equal(fmtDuration(-5000), '0:00');
  });
});

describe('fmtClock', () => {
  it('zero-pads minutes for a stable transcript column', () => {
    assert.equal(fmtClock(0), '00:00');
    assert.equal(fmtClock(2000), '00:02');
    assert.equal(fmtClock(62_000), '01:02');
  });

  it('grows to hours for long meetings', () => {
    assert.equal(fmtClock(3_725_000), '1:02:05');
  });
});

describe('fmtBytes', () => {
  it('scales through the units', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup from transcript text', () => {
    assert.equal(escapeHtml('<script>alert("x")</script>'),
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('handles null and undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('highlight', () => {
  it('wraps every case-insensitive match', () => {
    assert.equal(highlight('Billing and billing', 'billing'),
      '<mark>Billing</mark> and <mark>billing</mark>');
  });

  it('escapes the surrounding text', () => {
    assert.match(highlight('<b>billing</b>', 'billing'), /&lt;b&gt;<mark>billing<\/mark>/);
  });

  it('treats regex metacharacters in the query literally', () => {
    // A naive implementation would throw or match everything here.
    assert.equal(highlight('cost is 5.00 today', '5.00'), 'cost is <mark>5.00</mark> today');
    assert.equal(highlight('a+b', 'a+'), '<mark>a+</mark>b');
    assert.equal(highlight('nothing here', '('), 'nothing here');
  });

  it('returns escaped text when the query is empty', () => {
    assert.equal(highlight('<i>x</i>', ''), '&lt;i&gt;x&lt;/i&gt;');
  });
});

describe('sentencesOf', () => {
  it('splits on sentence boundaries', () => {
    assert.deepEqual(sentencesOf('One thing. Two things! Three?'),
      ['One thing.', 'Two things!', 'Three?']);
  });

  it('collapses whitespace and drops empties', () => {
    assert.deepEqual(sentencesOf('  A   sentence.\n\n Another one. '),
      ['A sentence.', 'Another one.']);
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(sentencesOf(''), []);
    assert.deepEqual(sentencesOf(null), []);
  });
});
