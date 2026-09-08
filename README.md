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

Nothing to install or build. Clone it and open `index.html` through any static
server:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

For AI analysis, add an [Anthropic API key](https://console.anthropic.com/) in
**Settings → AI analysis**. Without one the app still records, transcribes,
stores, searches and exports — and falls back to an on-device extractive
summary that is always labelled as such.

### About the API key

The key is kept in `localStorage` and sent from the page straight to
`api.anthropic.com` (which needs the `anthropic-dangerous-direct-browser-access`
header to allow a browser origin). That is the trade-off a static, server-less
app makes: the key never goes to any server of ours because there is no server —
but anything with script access to this origin can read it. Use a key scoped to
this app, and clear it in Settings when you are done. If you would rather the key
never touch a browser, put a small proxy in front of the API and point `ENDPOINT`
in `js/ai.js` at it.

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
index.html              app shell
manifest.webmanifest    PWA manifest
sw.js                   service worker (precached shell, offline)
css/app.css             design tokens + all styling
js/
  app.js                hash router, top bar, SW registration
  settings.js           preferences + API key (localStorage)
  db.js                 IndexedDB: meetings + audio blobs
  recorder.js           getUserMedia + MediaRecorder, level meter, wake lock
  asr.js                Web Speech API wrapper, auto-restart, speaker split
  ai.js                 Claude Messages API client (streaming, structured output)
  local-summary.js      on-device extractive fallback
  export.js             Markdown / text / JSON / audio / share sheet
  ui.js                 toasts, bottom sheets, dialogs
  views/                record, library, meeting, settings
tools/make_icons.py     regenerates the icon set (stdlib only)
docs/architecture.md    how the pieces fit together
```

See [`docs/architecture.md`](docs/architecture.md) for the data model, the
recording clock, and how analysis is prompted.

---

_This repository previously held a placeholder page from Codecademy's CLI
training._
