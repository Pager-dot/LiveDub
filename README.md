# LiveDub 🎙️

Play any foreign-language video or call and get **live English captions**, an **AI English voiceover**, and a **side-by-side compare view** of the original and translated speech.

Inspired by [vid_translate](https://github.com/Pager-dot/vid_translate).

## Features

- 🖥 **Another tab / call** – dub YouTube, Google Meet, Zoom web or Teams playing in another Chrome tab. Chrome's native tab sharing hands LiveDub that tab's audio (even while the tab itself is muted); LiveDub replays it quieter under the English voice
- ⧉ **Picture-in-Picture widget** – an always-on-top floating window with the tab preview, captions and Start/Stop, so you can go back to the video tab
- 📁 **Video file** – play a local video; the original audio is ducked while the dub speaks
- 💬 Translated captions over the video, with the original line underneath
- 🔊 English voiceover that speeds up slightly to catch up when it falls behind
- ⇄ Compare panel: original text + translation per segment, play the original clip and the dub
- 📝 Export English captions as `.srt`

## How it works

Audio is recorded in short chunks (default 5 s) and each chunk goes through:

1. **ElevenLabs Scribe** (`scribe_v1`) – speech-to-text
2. **Gemini Flash-Lite** (`gemini-3.5-flash-lite`) – translation to natural spoken English, using the last few lines as context
3. **ElevenLabs Flash** (`eleven_flash_v2_5`, the cheapest ElevenLabs voice model) – English text-to-speech

A tiny Express server (`server.js`) proxies these APIs. API keys live in the server's `.env` file and never reach the browser.

## Run the server

```bash
npm install
cp .env.example .env   # then fill in ELEVENLABS_API_KEY and GEMINI_API_KEY
npm start
```

## Use it (no install needed)

1. Open the site in Chrome or Edge.
2. Open the video or call in **another tab**.
3. Back in LiveDub press **Start dubbing**, choose that tab under **Chrome tab**, keep **Also share tab audio** on, and press Share.
4. Press **⧉ Pop out** for the floating Picture-in-Picture captions window, then switch back to the video tab.

## Chrome extension (optional)

Dub any tab without leaving it: a floating panel and caption overlay appear right on YouTube, Meet, Zoom or Teams.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension/` folder.
2. Pin the LiveDub icon, open a video or call, and click the icon (or press **Alt+Shift+D**). Click again to stop.
4. Drag the panel anywhere; ⚙ opens settings, – minimises it. Use ▶ Original / ▶ English to compare lines.
5. Using a hosted server (e.g. DigitalOcean)? Set its URL in ⚙ → **Server URL**.


## Tech

Node.js, Express, vanilla JS, Web Audio API, MediaRecorder, Screen Capture API, Document Picture-in-Picture API, ElevenLabs, Gemini.

## Limitations

- Captions lag ~5–8 s behind speech (chunk length + three API calls).
- Tab capture and the Picture-in-Picture window need Chrome or Edge (116+) over HTTPS or localhost.

## Changelog

### Keys moved to the server (`.env`)
- **What:** `ELEVENLABS_API_KEY` and the translation key are read from `.env` (see `.env.example`); the key fields were removed from the UI. `/api/health` reports whether they are set.
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

### Website captures other tabs + Picture-in-Picture widget
- **What:** removed the in-page YouTube player. The main mode now captures **another** tab with Chrome's native tab sharing (`getDisplayMedia`, `selfBrowserSurface: "exclude"`, `suppressLocalAudioPlayback`), replays its audio on the LiveDub page through a gain node (ducked under the dub, or muted via "Hear the original audio"), and a **⧉ Pop out** button opens a Document Picture-in-Picture window with the preview, captions and Start/Stop.
- **Why:** capturing the LiveDub tab itself also captured the English dub, which got transcribed and dubbed again in an endless loop ("Thank you for bringing this, Su Chan" repeating while the video was paused). Excluding our own tab removes the loop. Judges also shouldn't have to install an extension, so the floating widget is now built into the website with Picture-in-Picture.

### Translation moved from Gemma 4 to Gemini Flash-Lite
- **What:** `/api/translate` now calls `gemini-3.5-flash-lite` on the Gemini API (`GEMINI_API_KEY`, override with `GEMINI_MODEL`) instead of `gemma4:31b-cloud` on Ollama Cloud. `OLLAMA_API_KEY` is no longer used.
- **Why:** we wanted Gemma 4 to hear the audio directly, but no hosted Gemma 4 accepts audio: ollama.com's `gemma4:31b-cloud` only lists vision, the Gemini API's `gemma-4-31b-it` / `gemma-4-26b-a4b-it` return "Audio input modality is not enabled", and the small audio-capable E2B/E4B variants aren't hosted. Since Gemma was then only translating, we switched to Flash-Lite, which is cheaper and faster (~1 s per line). ElevenLabs stays on its cheapest models: Scribe v1 for STT and Flash v2.5 (half the credits per character) for TTS.

### Only a single Chrome tab can be shared; dub plays from the pop-out
- **What:** LiveDub now rejects a shared window or entire screen and asks for a Chrome tab (`displaySurface` must be `browser`; `surfaceSwitching`, `systemAudio` and `windowAudio` excluded). The shared tab is silenced by Chrome, the English voice plays through Web Audio (from the ⧉ Pop out window when it is open), a 🔊 Test button checks the voice is audible, and a repeat filter drops any transcript that is mostly words LiveDub just spoke.
- **Why:** debugging showed the share picker had captured a *window with system audio*. System audio includes LiveDub's own English voice, so it was re-dubbed in a loop, and silencing the shared source muted the dub itself. Restricting capture to one tab fixes both. Web Audio is used because Chrome defers `<audio>` playback in background tabs.

### Male / female voice matching
- **What:** while each chunk records, LiveDub estimates the speaker's pitch (autocorrelation on clearly voiced frames, median per chunk). 165 Hz and above uses the female English voice (default Sarah), below uses the male voice (default George). Toggle **Match speaker** in Settings; the compare panel shows the guess and pitch (e.g. `♀ 212 Hz`).
- **Why:** a single voice for everyone made conversations hard to follow. Pitch runs in the browser, so it adds no API calls or cost. It is a heuristic: kids, music, or two speakers in one chunk can fool it.

### Login removed
- **What:** removed email/password sign-up, `auth.js` and the `pg-mem` dependency; the API routes are open again and the site opens straight to the dubbing screen.
- **Why:** the hosted demo only runs for a few hours on the event day, so accounts added friction for judges (and needed extra production config) without much benefit. API keys still stay on the server.

## Deploy on Render

`render.yaml` is a Render Blueprint: in the Render dashboard choose **New → Blueprint**, pick this repo, and paste `ELEVENLABS_API_KEY` and `GEMINI_API_KEY` when asked. It runs on the free plan with HTTPS, which Chrome needs for tab capture.
