# LiveDub 🎙️

Play any foreign-language video or call and get **live English captions**, an **AI English voiceover**, and a **side-by-side compare view** of the original and translated speech.

Inspired by [vid_translate](https://github.com/Pager-dot/vid_translate).

## Features

- 📁 **Video file** – play a local video; the original audio is ducked while the dub speaks
- ▶ **YouTube** – paste a link, share "This tab" with audio
- 🖥 **Tab / video call** – dub a Google Meet, Zoom web, Teams or YouTube tab live
- 💬 Translated captions over the video, with the original line underneath
- 🔊 English voiceover that speeds up slightly to catch up when it falls behind
- ⇄ Compare panel: original text + translation per segment, play the original clip and the dub
- 📝 Export English captions as `.srt`

## How it works

Audio is recorded in short chunks (default 5 s) and each chunk goes through:

1. **ElevenLabs Scribe** – speech-to-text
2. **Gemma 4** (`gemma4:31b-cloud` via Ollama Cloud) – translation to natural spoken English, using the last few lines as context
3. **ElevenLabs Flash** – English text-to-speech

A tiny Express server (`server.js`) proxies these APIs. API keys live in the server's `.env` file and never reach the browser. Every API call requires a logged-in account (email + password).

## Run the server

```bash
npm install
cp .env.example .env   # then fill in ELEVENLABS_API_KEY and OLLAMA_API_KEY
npm start
```

Open the site or the widget and **sign up with an email and password** before dubbing.

## Chrome widget (recommended)

Dub any tab without leaving it: a floating panel and caption overlay appear right on YouTube, Meet, Zoom or Teams.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension/` folder.
2. Pin the LiveDub icon, open a video or call, and click the icon (or press **Alt+Shift+D**). Click again to stop.
3. Log in or sign up in the panel the first time.
4. Drag the panel anywhere; ⚙ opens settings, – minimises it. Use ▶ Original / ▶ English to compare lines.
5. Using a hosted server (e.g. DigitalOcean)? Set its URL in ⚙ → **Server URL**.

## Web app

Open http://localhost:3000 in Chrome or Edge to dub a local video file, a YouTube link, or another shared tab.

## Tech

Node.js, Express, pg-mem (in-memory Postgres), vanilla JS, Web Audio API, MediaRecorder, Screen Capture API, YouTube IFrame API, ElevenLabs, Ollama, Gemma 4.

## Limitations

- Captions lag ~5–8 s behind speech (chunk length + three API calls).
- In YouTube mode the dub plays in the captured tab; Chrome's `restrictOwnAudio` keeps it out of the capture where supported. Otherwise use Tab mode with YouTube in another tab.

## Changelog

### Keys moved to the server (`.env`)
- **What:** `ELEVENLABS_API_KEY` and `OLLAMA_API_KEY` are read from `.env` (see `.env.example`); the key fields were removed from the UI. `/api/health` reports whether they are set.
- **Why:** visitors shouldn't need their own API keys, and keys should never be exposed to the browser.

### Chrome extension widget (`extension/`)
- **What:** a Manifest V3 extension. Clicking the toolbar icon (or Alt+Shift+D) captures the current tab's audio with `tabCapture`, processes it in an offscreen document, and shows a draggable panel plus caption overlay on the page itself.
- **Why:** users shouldn't have to switch to a separate LiveDub tab or pick a tab in a share dialog. The voiceover plays from the offscreen document, so it is never re-captured and re-translated (fixing the echo loop of in-page YouTube mode).

### Email + password accounts
- **What:** `/api/signup`, `/api/login`, `/api/logout`, `/api/me`, backed by an in-memory Postgres (pg-mem). Passwords are hashed with scrypt; sessions use an HttpOnly cookie (web app) or a Bearer token (extension). STT, translate, TTS and voices all require login.
- **Why:** the server pays for the APIs, so anonymous visitors and drive-by bots must not be able to spend the credits. In-memory storage was chosen because the hosted demo only needs to run for one day; **all accounts reset when the server restarts.** No email is sent (no verification).

### Ready for DigitalOcean App Platform
- **What:** CORS for the extension, configurable **Server URL** in the widget, `https://*.ondigitalocean.app` host permission, `engines.node >= 22.9`, and `PORT` from the environment.
- **Why:** screen/tab capture needs HTTPS, which App Platform provides; set the two API keys as encrypted environment variables there instead of uploading `.env`.
