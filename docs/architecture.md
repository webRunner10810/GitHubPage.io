# Architecture

No framework, no bundler, no build step. Native ES modules loaded straight from
`index.html`, which keeps the service worker's precache list a literal list of
the files that ship and makes the whole thing deployable by `git push`.

## Layers

```
views/          render + user intent            (record, library, meeting, settings)
  ↓
app.js          hash router, top bar, SW registration
  ↓
recorder.js  asr.js  ai.js  local-summary.js  export.js
  ↓
db.js  settings.js                              IndexedDB + localStorage
```

Views own no persistent state. Anything that must survive a tab switch lives in
a module (`record.js` holds the live session) or in IndexedDB.

## The recording clock

`Recorder.elapsed()` is the single time source. It accumulates
`performance.now()` deltas and excludes paused time, so it matches the length of
the audio file rather than wall-clock time.

`Transcriber` never reads a clock of its own — the record view injects
`clock: () => recorder.elapsed()`. Every transcript segment is therefore stamped
in the same coordinate space as the audio, which is what makes tap-a-line-to-seek
line up on playback.

## Live transcription

Chrome ends a `SpeechRecognition` session after each natural pause even with
`continuous = true`. `asr.js` treats that as normal and restarts, with backoff
only when the previous session ended in a real error. `no-speech` and `aborted`
are silent; `not-allowed`, `service-not-allowed` and `audio-capture` are fatal
and stop the transcriber; `network` is surfaced but keeps retrying, because the
audio recording is still fine and the user should not lose it.

A phrase's start time is captured on the first interim result and its end time
when the result goes final, minus a small lead-in — recognition reports words
slightly after they are spoken.

## Speaker labels

`assignSpeakers()` toggles between `S1` and `S2` whenever the gap between two
phrases exceeds a threshold (1500 ms by default, configurable). This is a
heuristic and the UI never pretends otherwise: labels are editable, the split
can be recalculated, and the system prompt tells the model the labels are
unreliable so it does not attribute claims to the wrong person.

`mergeSegments()` then joins consecutive same-speaker phrases that are close
together, so the transcript reads in paragraphs rather than fragments.

## Storage

Four IndexedDB object stores:

- **`meetings`** — metadata, transcript segments, analysis, chat history. Small,
  read on every library render.
- **`audio`** — one finished Blob per meeting, keyed by the same id. Large, read
  only on playback or export.
- **`liveSession`** — the single in-progress recording, if any.
- **`liveChunks`** — that recording's audio chunks as they arrive.

Splitting meetings from audio keeps the library list cheap: it never pulls
megabytes into memory to draw a list of cards. `navigator.storage.persist()` is
requested on the first recording so Android is less likely to evict recordings
under storage pressure.

Settings, the API key and the optional proxy URL live in `localStorage` (see the
README for the trade-off the direct-key option represents).

## Crash safety

Android kills backgrounded tabs without warning, and a lost hour-long meeting is
not a recoverable error for the person who recorded it. So nothing is held only
in memory:

- `MediaRecorder` runs on a one-second timeslice and the recorder **emits** each
  chunk rather than accumulating it. The record view writes each one to
  `liveChunks` immediately. A three-hour meeting therefore never sits on the
  heap, which also fixes an unbounded-memory problem on long recordings.
- Every finalised transcript line is written to `liveSession` as it lands, along
  with a duration heartbeat every five seconds.
- All of it goes through one serialised promise chain, so writes from a
  one-second timeslice cannot interleave and stopping has a single thing to
  await before assembling the file.
- On stop, the audio Blob is assembled *from what was persisted*, not from
  memory. Recovery runs the identical code path, so a recovered meeting and a
  normally-saved one are the same record.

On launch, a session left behind by a killed tab is offered back with what it
captured. The user may defer that choice — but not twice: starting a new
recording would replace the stored session, so the app asks again without the
"decide later" option rather than silently destroying the earlier meeting.

If a chunk write fails because the device is out of storage, audio recording
stops and transcription continues, rather than losing the meeting entirely. If
the final save hits quota, the transcript and notes are saved without the audio.

## Analysis

`ai.js` calls `POST https://api.anthropic.com/v1/messages` directly from the
page, with `anthropic-dangerous-direct-browser-access: true` to allow the
browser origin.

- **Streaming.** Every request sets `stream: true`. `SseDecoder` handles the
  framing — it is pure, holds partial frames across chunk boundaries, and is
  unit-tested against the ugly cases (a payload split mid-JSON, CRLF endings, a
  multi-byte character cut in half). Streaming keeps a long meeting away from
  request timeouts and gives the UI a progress bar.
- **Retries.** Transient failures (429, 5xx, network) are retried up to three
  times with exponential backoff, honouring `retry-after`. A stream that already
  emitted text is never replayed — it is marked and the retry loop gives up
  rather than duplicating output.
- **Cancellation.** Each run holds an `AbortController`; the progress card has a
  Cancel button, and navigating away aborts an in-flight question.
- **Proxy.** `apiBaseUrl` redirects every request to a deployment of
  `proxy/cloudflare-worker.js`. When it is set the app sends no credentials at
  all and Settings hides the key field.
- **Structured output.** The analysis pass passes a JSON Schema through
  `output_config.format`, so the response parses into the exact shape the views
  render — no prompt-level "reply with JSON" wishful thinking.
- **Effort, not budgets.** `output_config.effort` is user-configurable. Thinking
  is left unset: it is adaptive by default on Opus 5.
- **Long transcripts.** Past ~240k characters the transcript is split on segment
  boundaries, each part is condensed into dense notes, and the structured pass
  runs over the notes. Under that threshold the whole transcript goes in one
  request.
- **Prompting for ASR.** The system prompt states up front that the input is
  machine-transcribed: punctuation and proper nouns will be wrong, speaker
  labels are a guess, and cross-talk is normal. It also draws the line between a
  topic that was discussed and a decision that was settled, so the notes do not
  inflate.

Progress and completion are broadcast as `summary:*` window events rather than
returned to a caller, so analysis started on the record screen still updates the
detail screen the user has navigated to.

## Failure behaviour

The app is useful when things are missing, and says which thing is missing:

| Missing | Behaviour |
|---|---|
| API key | On-device extractive summary, labelled "On-device" everywhere it appears. |
| Network | Recording, playback, search and export work; analysis reports being offline. |
| Speech recognition | Records audio and says live text is unavailable in this browser. |
| Microphone permission | Explains that access was denied and where to re-enable it. |
| Audio evicted or never kept | Transcript still renders; playback controls say so instead of erroring. |

## Regenerating icons

`python3 tools/make_icons.py` writes the PNG icon set from a small pure-stdlib
rasteriser (no imaging library needed). Change the gradient constants at the top
of that file to restyle them.

## Why there is no build step

The app is 14 ES modules loaded directly by the browser. That is a deliberate
choice for something deployed to GitHub Pages: `git push` is the whole pipeline,
the service worker's precache list is a literal list of the files that ship, and
there is no toolchain to rot between the code and what runs.

What a bundler would have caught for free is instead checked by
`tools/check-static.mjs`, which runs in CI and fails the build on:

- a precached path that no longer exists, or a shipped module missing from the
  precache list (it would silently stop working offline)
- a relative import that does not resolve
- a manifest that is invalid, missing required fields, or referencing a missing
  icon
- an absolute or root-relative path in `index.html` (the site is served from a
  project subpath, so those break)
- an inline `style` attribute, which the Content-Security-Policy blocks —
  dynamic values go through CSSOM instead
- a stray `debugger` or `console.log`

## Testing

- `test/unit/` — `node:test`, no browser. Covers the pure logic: speaker
  splitting and merging, SSE framing, analysis normalisation, the on-device
  summariser, export formatting and the display helpers.
- `test/e2e/` — Playwright at a 412x915 Pixel viewport with a fake microphone.
  Covers real capture, both analysis paths against a mocked API (asserting the
  wire format, not just the rendering), retry and error handling, the proxy
  path, review and editing, search, deletion, and crash recovery — which kills
  the page mid-recording and asserts the meeting comes back.

`asr.js` reads the speech API through `globalThis` rather than `window` so its
pure transforms can be imported and tested outside a browser.
