// Offscreen document: owns the captured tab audio, chunks it, runs STT -> translate -> TTS on the
// LiveDub server, plays the voiceover, and reports segments to the widget via the background worker.
const DEFAULTS = { lang: "auto", chunk: 5, duck: 0.2, dub: true, voice: "JBFqnCBsd6RMkjVDRZzb" };

let cfg = { ...DEFAULTS }, stream, ctx, gain, analyser, running = false;
let recorder, chunkTimer, startedAt = 0, segIdx = 0, peak = 0, meterTimer;
let chain = Promise.resolve();
const history = [], clips = new Map(); // id -> { orig, dub } blob URLs, played here so they aren't re-captured
const dubAudio = new Audio();

const toWidget = (payload) => chrome.runtime.sendMessage({ target: "background", payload });
const status = (text, err = false) => toWidget({ type: "status", text, err });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") start(msg.streamId, msg.settings);
  if (msg.type === "stop") stop();
  if (msg.type === "settings") cfg = { ...DEFAULTS, ...msg.settings };
  if (msg.type === "play") {
    const c = clips.get(msg.id);
    const url = c && (msg.kind === "orig" ? c.orig : c.dub);
    if (url) new Audio(url).play();
  }
});

async function start(streamId, settings) {
  stop();
  cfg = { ...DEFAULTS, ...settings };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    return status("Audio capture failed: " + e.message, true);
  }
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  gain = ctx.createGain();
  src.connect(gain).connect(ctx.destination); // capturing mutes the tab, so play it back here
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  running = true;
  startedAt = performance.now();
  meterTimer = setInterval(() => (peak = Math.max(peak, rms())), 80);
  toWidget({ type: "state", running: true });
  status("Listening…");
  recordChunk();
}

function stop() {
  running = false;
  clearTimeout(chunkTimer);
  clearInterval(meterTimer);
  if (recorder?.state === "recording") recorder.stop();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  dubAudio.pause();
  ctx?.close();
  ctx = null;
}

const buf = new Float32Array(1024);
function rms() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

function recordChunk() {
  if (!running) return;
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const parts = [], t0 = (performance.now() - startedAt) / 1000;
  peak = 0;
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = () => {
    const loud = peak;
    if (running) recordChunk();
    if (loud < 0.01) return; // silence
    handleChunk(new Blob(parts, { type: rec.mimeType }), t0, (performance.now() - startedAt) / 1000);
  };
  rec.start();
  recorder = rec;
  chunkTimer = setTimeout(() => rec.state === "recording" && rec.stop(), cfg.chunk * 1000);
}

async function api(path, opts, json = true) {
  const { server = "http://localhost:3000", token = "" } = await chrome.storage.local.get(["server", "token"]);
  const r = await fetch(server.replace(/\/$/, "") + path, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && running) { running = false; toWidget({ type: "auth" }); chrome.runtime.sendMessage({ target: "background", type: "stop" }); }
    throw new Error(j.error || r.statusText);
  }
  return json ? r.json() : r.blob();
}

function handleChunk(blob, t0, t1) {
  const c = cfg, id = ++segIdx, sent = performance.now();
  const work = (async () => {
    const stt = await api(`/api/stt?lang=${c.lang}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    if (!stt.text || stt.text.length < 2) return null;
    const tr = await api("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: stt.text, source: stt.language || c.lang, context: history.slice(-3) }),
    });
    if (!tr.text) return null;
    history.push(stt.text);
    const audio = c.dub
      ? await api("/api/tts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: tr.text, voiceId: c.voice }),
        }, false).catch((e) => (status("Voiceover: " + e.message, true), null))
      : null;
    clips.set(id, { orig: URL.createObjectURL(blob), dub: audio && URL.createObjectURL(audio) });
    return { id, t0, t1, orig: stt.text, lang: stt.language, en: tr.text, hasDub: !!audio,
      latency: (performance.now() - sent) / 1000 };
  })().catch((e) => {
    status(e.message.includes("fetch") ? "Can't reach the LiveDub server — check the Server URL in ⚙ and that it is running" : e.message, true);
    return null;
  });

  chain = chain.then(async () => {
    const seg = await work;
    if (!seg || !running) return;
    toWidget({ type: "segment", seg });
    if (seg.hasDub) await playDub(seg);
  });
}

function playDub(seg) {
  return new Promise((res) => {
    const backlog = segIdx - seg.id;
    dubAudio.src = clips.get(seg.id).dub;
    dubAudio.playbackRate = backlog > 1 ? 1.25 : backlog > 0 ? 1.1 : 1;
    gain?.gain.setTargetAtTime(cfg.duck, ctx.currentTime, 0.15);
    toWidget({ type: "speaking", id: seg.id, on: true });
    const done = () => {
      if (gain && ctx) gain.gain.setTargetAtTime(1, ctx.currentTime, 0.15);
      toWidget({ type: "speaking", id: seg.id, on: false });
      res();
    };
    dubAudio.onended = done;
    dubAudio.onerror = done;
    dubAudio.play().catch(done);
  });
}
