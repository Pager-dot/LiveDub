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

A tiny Express server (`server.js`) proxies these APIs. API keys are entered in the browser, stored only in `localStorage`, and sent per request – never saved on the server.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in Chrome or Edge, then enter your ElevenLabs and Ollama API keys in Settings.

## Tech

Node.js, Express, vanilla JS, Web Audio API, MediaRecorder, Screen Capture API, YouTube IFrame API, ElevenLabs, Ollama, Gemma 4.

## Limitations

- Captions lag ~5–8 s behind speech (chunk length + three API calls).
- In YouTube mode the dub plays in the captured tab; Chrome's `restrictOwnAudio` keeps it out of the capture where supported. Otherwise use Tab mode with YouTube in another tab.
