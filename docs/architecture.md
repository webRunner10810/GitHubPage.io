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

Two IndexedDB object stores:

- **`meetings`** — metadata, transcript segments, analysis, chat history. Small,
  read on every library render.
- **`audio`** — one Blob per meeting, keyed by the same id. Large, read only on
  playback or export.

Splitting them keeps the library list cheap: it never pulls megabytes of audio
into memory to draw a list of cards. `navigator.storage.persist()` is requested
on the first recording so Android is less likely to evict recordings under
storage pressure.

Settings and the API key live in `localStorage` (see the README for the
trade-off that represents).

## Analysis

`ai.js` calls `POST https://api.anthropic.com/v1/messages` directly from the
page, with `anthropic-dangerous-direct-browser-access: true` to allow the
browser origin.

- **Streaming.** Every request sets `stream: true` and the SSE frames are parsed
  by hand from the `fetch` body stream. A long meeting can produce a long
  request; streaming keeps it away from request timeouts and gives the UI a
  progress bar.
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
