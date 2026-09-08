# Summary — AI meeting notes

A record-and-summarise web app, built as an installable PWA and tuned for a
Pixel 7. Record a meeting or a conversation, watch the transcript appear live,
and get back a summary, the decisions, and the action items.

Everything runs client-side: it is a static site with no backend, no build step
and no dependencies. Audio and transcripts stay in the browser's own storage on
the phone. The only thing that ever leaves the device is transcript *text*, and
only when you run AI analysis with your own Anthropic API key.

> **Live site:** enable GitHub Pages for this repo (Settings → Pages → deploy
> from `main`, folder `/`) and it will be served at
> `https://webrunner10810.github.io/GitHubPage.io/`. HTTPS is required — the
> microphone APIs do not work over plain HTTP, other than on `localhost`.

## What it does

| | |
|---|---|
| **Record** | Microphone capture with a live level meter, pause/resume, and a screen wake lock so the phone does not sleep mid-meeting. |
| **Transcribe** | Live speech-to-text with timestamps, restarted automatically after every natural pause so a long meeting keeps going. |
| **Split speakers** | Turn changes are guessed from pause length. It is a heuristic, not real diarization — you can rename and correct the speakers. |
| **Summarise** | Claude turns the transcript into a summary, key points, decisions, action items with owners and due dates, open questions, topics, tone, and a recap-email draft. |
| **Ask** | Follow-up questions answered from that one transcript ("what did I commit to?"). |
| **Review** | Playback with the transcript scrolling in sync — tap any line to jump to that moment in the audio. |
| **Keep** | Search across every recording, tick off action items, star, rename, fix mis-heard words. |
| **Export** | Markdown, plain text, full JSON, the audio file, or straight into the Android share sheet. |
| **Offline** | Installs as an app, opens and plays back with no network. Recording and playback work offline; live transcription and AI analysis need a connection. |
| **Survive a crash** | Audio and transcript are written to storage as they are captured. If Android kills the tab mid-meeting, the next launch offers the recording back instead of losing it. |

## Recording phone calls — read this first

**Android does not let a web app tap the call audio stream.** No browser API
exposes telephony audio; that is an OS restriction, not something this app can
work around. What works in practice:

- Put the call on **speakerphone**, then record. The handset microphone picks up
  both sides well enough to transcribe.
- Pick **Phone call** on the record screen. It does not change the capture path —
  it tells the analysis how the audio was captured, so it reads cross-talk and
  a distant second voice the way it should.
- **Consent rules vary by country and by US state**, and some require every
  participant to agree. Getting that agreement is on you.

## Setup

The app itself has no build step and no runtime dependencies. Clone it and serve
the directory:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

The dev dependencies in `package.json` are for the test suite and linter only —
nothing from `node_modules` is shipped.

```bash
npm install
npm test          # lint + static checks + unit tests + end-to-end tests
npm run lint
npm run check     # static integrity: precache list, imports, manifest, CSP
npm run test:unit # node:test, no browser needed
npm run test:e2e  # Playwright at a 412x915 Pixel viewport
```

`npm run test:e2e` downloads its own Chromium. In a sandbox that already ships
one, point at it instead:
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e`.

For AI analysis, add an [Anthropic API key](https://console.anthropic.com/) in
**Settings → AI analysis**. Without one the app still records, transcribes,
stores, searches and exports — and falls back to an on-device extractive
summary that is always labelled as such.

### About the API key

Two options, and the app supports both:

**Direct (default).** The key is kept in `localStorage` and sent from the page
straight to `api.anthropic.com` (which needs the
`anthropic-dangerous-direct-browser-access` header to allow a browser origin).
It never goes to any server of ours, because there is no server — but anything
with script access to this origin can read it. Use a key scoped to this app and
clear it in Settings when you are done.

**Proxied (recommended if the key matters).** Deploy
[`proxy/cloudflare-worker.js`](proxy/README.md) and paste its URL into
**Settings → Proxy URL**. The key then lives in the Worker's secret store, the
page sends no credentials at all, and the API key field disappears from
Settings because it is no longer needed.

## Browser support

Built and tested against Chrome on Android (the Pixel 7 target) and desktop
Chrome.

| Feature | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| Recording, storage, playback, export | ✅ | ✅ | ✅ |
| Live transcription (Web Speech API) | ✅ | Partial | ❌ |
| Install as an app | ✅ | ✅ | Partial |
| Android share sheet | ✅ | ✅ | ❌ |

Chrome's speech recognition is cloud-backed, so live transcription needs a
network connection. Where it is unavailable, the app records audio and says so
rather than failing quietly.

## Layout

```
index.html              app shell (+ Content-Security-Policy)
manifest.webmanifest    PWA manifest
sw.js                   service worker (precached shell, offline)
css/app.css             design tokens, components, layout utilities
js/
  app.js                hash router, top bar, SW registration
  settings.js           preferences, API key / proxy URL (localStorage)
  db.js                 IndexedDB: meetings, audio, and the live session
  recorder.js           getUserMedia + MediaRecorder, level meter, wake lock
  asr.js                Web Speech API wrapper, auto-restart, speaker split
  ai.js                 Messages API client: streaming, retries, structured output
  local-summary.js      on-device extractive fallback
  export.js             Markdown / text / JSON / audio / share sheet
  ui.js                 toasts, bottom sheets, dialogs
  views/                record, library, meeting, settings
proxy/                  optional Worker that keeps the API key server-side
test/unit/              node:test suites for the pure logic
test/e2e/               Playwright flows, including crash recovery
tools/make_icons.py     regenerates the icon set (stdlib only)
tools/check-static.mjs  integrity checks a bundler would otherwise catch
tools/stamp-version.mjs stamps the commit SHA into the SW cache name
docs/architecture.md    how the pieces fit together
```

## CI

`.github/workflows/ci.yml` runs lint, the static checks, the unit tests and the
Playwright suite on every pull request. `.github/workflows/deploy.yml` publishes
to Pages on `master`, stamping the commit SHA into the service worker's cache
name first — without that the cache-first service worker would keep serving the
previous bundle to returning visitors.

See [`docs/architecture.md`](docs/architecture.md) for the data model, the
recording clock, and how analysis is prompted.

---

_This repository previously held a placeholder page from Codecademy's CLI
training._
