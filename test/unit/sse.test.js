/* The Server-Sent Events decoder that every streaming API response goes
   through. Chunk boundaries land wherever the network puts them, so the
   important cases are the ugly ones. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SseDecoder } from '../../js/ai.js';

const frame = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

describe('SseDecoder', () => {
  it('parses whole frames', () => {
    const sse = new SseDecoder();
    const events = sse.push(frame({ type: 'a', n: 1 }) + frame({ type: 'b', n: 2 }));
    assert.deepEqual(events.map((e) => e.type), ['a', 'b']);
  });

  it('holds a partial frame until the rest arrives', () => {
    const sse = new SseDecoder();
    const whole = frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
    const cut = Math.floor(whole.length / 2);

    assert.deepEqual(sse.push(whole.slice(0, cut)), []);
    const events = sse.push(whole.slice(cut));
    assert.equal(events.length, 1);
    assert.equal(events[0].delta.text, 'hello');
  });

  it('reassembles a payload split mid-JSON across three chunks', () => {
    const sse = new SseDecoder();
    const whole = frame({ type: 'x', text: 'abcdefghijklmnop' });
    assert.deepEqual(sse.push(whole.slice(0, 10)), []);
    assert.deepEqual(sse.push(whole.slice(10, 25)), []);
    const events = sse.push(whole.slice(25));
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'abcdefghijklmnop');
  });

  it('accepts CRLF line endings', () => {
    const sse = new SseDecoder();
    const events = sse.push('event: ping\r\ndata: {"type":"ping"}\r\n\r\n');
    assert.deepEqual(events.map((e) => e.type), ['ping']);
  });

  it('ignores comments, empty data and the [DONE] sentinel', () => {
    const sse = new SseDecoder();
    const events = sse.push(': keep-alive\n\ndata: \n\ndata: [DONE]\n\n' + frame({ type: 'real' }));
    assert.deepEqual(events.map((e) => e.type), ['real']);
  });

  it('skips a malformed payload instead of failing the stream', () => {
    const sse = new SseDecoder();
    const events = sse.push('data: {not json}\n\n' + frame({ type: 'survivor' }));
    assert.deepEqual(events.map((e) => e.type), ['survivor']);
  });

  it('decodes Uint8Array chunks', () => {
    const sse = new SseDecoder();
    const bytes = new TextEncoder().encode(frame({ type: 'bytes', ok: true }));
    const events = sse.push(bytes);
    assert.equal(events[0].ok, true);
  });

  it('handles a multi-byte character split across chunk boundaries', () => {
    const sse = new SseDecoder();
    const whole = new TextEncoder().encode(frame({ type: 'emoji', text: 'déjà vu 🎧' }));
    // Cut inside the multi-byte sequence.
    const cut = whole.indexOf(0xf0) + 2;
    assert.deepEqual(sse.push(whole.slice(0, cut)), []);
    const events = sse.push(whole.slice(cut));
    assert.equal(events[0].text, 'déjà vu 🎧');
  });
});
