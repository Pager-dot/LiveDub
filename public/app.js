// LiveDub client: capture audio -> chunk -> STT -> translate -> TTS -> captions + voiceover.
const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- settings ----------
const S = ["voice", "lang", "chunk", "duck"];
const CHECKS = ["showOrig", "dubOn", "hearOrig2"];
function loadSettings() {
  S.forEach((id) => { const v = store.get("ld_" + id); if (v != null) { ensureOption(id, v); $("#" + id).value = v; } });
  CHECKS.forEach((id) => { const v = store.get("ld_" + id); if (v != null) $("#" + id).checked = v === "1"; });
  $("#chunkVal").textContent = $("#chunk").value;
  $("#duckVal").textContent = $("#duck").value;
}
function ensureOption(id, v) {
  const el = $("#" + id);
  if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) el.add(new Option(store.get("ld_voiceName", v), v));
}
function saveSettings() {
  S.forEach((id) => store.set("ld_" + id, $("#" + id).value));
  CHECKS.forEach((id) => store.set("ld_" + id, $("#" + id).checked ? "1" : "0"));
  const v = $("#voice"); store.set("ld_voiceName", v.options[v.selectedIndex]?.text || "");
}
const cfg = () => ({
  voice: $("#voice").value, lang: $("#lang").value,
  chunk: +$("#chunk").value, duck: +$("#duck").value / 100, showOrig: $("#showOrig").checked, dub: $("#dubOn").checked,
  hearOrig: $("#hearOrig2").checked,
});
loadSettings();
$("#settingsBtn").onclick = () => $("#settings").showModal();
$("#settings").addEventListener("close", () => { saveSettings(); setOriginalVolume(1); });
$("#chunk").oninput = (e) => ($("#chunkVal").textContent = e.target.value);
$("#duck").oninput = (e) => ($("#duckVal").textContent = e.target.value);
$("#loadVoices").onclick = async () => {
  try {
    const r = await fetch("/api/voices");
    const list = await r.json();
    if (!r.ok) throw new Error(list.error);
    const sel = $("#voice"), cur = sel.value;
    sel.innerHTML = "";
    list.forEach((v) => sel.add(new Option(v.name, v.id)));
    if (list.some((v) => v.id === cur)) sel.value = cur;
  } catch (e) { alert("Could not load voices: " + e.message); }
};
// ---------- account ----------
let signup = false;
function showAuth(on) { $("#auth").classList.toggle("hidden", !on); if (on) $("#authEmail").focus(); }
function setUser(email) {
  $("#whoEmail").textContent = email || "";
  $("#logoutBtn").classList.toggle("hidden", !email);
  showAuth(!email);
}
$("#authSwitch").onclick = (e) => {
  e.preventDefault();
  signup = !signup;
  $("#authTitle").textContent = signup ? "Create your LiveDub account" : "Log in to LiveDub";
  $("#authSubmit").textContent = signup ? "Sign up" : "Log in";
  $("#authSwitchText").textContent = signup ? "Already have an account?" : "No account?";
  $("#authSwitch").textContent = signup ? "Log in" : "Sign up";
  $("#authPass").autocomplete = signup ? "new-password" : "current-password";
  $("#authErr").textContent = "";
};
$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const r = await fetch(signup ? "/api/signup" : "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: $("#authEmail").value, password: $("#authPass").value }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return ($("#authErr").textContent = j.error || "Something went wrong");
  $("#authPass").value = "";
  setUser(j.email);
};
$("#logoutBtn").onclick = async () => { if (running) stop(); await fetch("/api/logout", { method: "POST" }); setUser(null); };
fetch("/api/me").then((r) => (r.ok ? r.json() : {})).then((j) => setUser(j.email)).catch(() => setUser(null));

fetch("/api/health").then((r) => r.json()).then((h) => {
  if (!h.elevenlabs || !h.gemini) status("Server is missing API keys — fill in .env and restart", "err");
}).catch(() => {});

// ---------- source modes ----------
let mode = "tab";
const video = $("#video");
video.controls = false;
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  if (running) stop();
  mode = b.dataset.mode;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".source").forEach((s) => s.classList.toggle("hidden", s.dataset.src !== mode));
  video.controls = mode === "file";
  $("#placeholder").textContent = mode === "file" ? "Choose a video file to begin" : "Press Start dubbing and pick the tab to translate";
  $("#placeholder").classList.toggle("hidden", mode === "file" ? !!video.getAttribute("src") : !!video.srcObject);
}));

$("#fileInput").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  video.srcObject = null;
  video.src = URL.createObjectURL(f);
  video.muted = false;
  $("#placeholder").classList.add("hidden");
};

// ---------- audio graph ----------
// The original audio always plays through origGain on this page, so it can be ducked under the dub.
// For another tab, the user mutes that tab (right-click → Mute site); capture still receives its audio.
let ctx, mediaSrc, origGain, analyser, capStream, displayStream, tabSrc;
function audioCtx() {
  if (!ctx) {
    ctx = new AudioContext();
    origGain = ctx.createGain();
    origGain.connect(ctx.destination);
  }
  ctx.resume();
  return ctx;
}
const baseVolume = () => (cfg().hearOrig ? 1 : 0);
async function getCaptureStream() {
  const c = audioCtx();
  origGain.gain.value = baseVolume();
  if (mode === "file") {
    if (!video.getAttribute("src")) throw new Error("Choose a video file first");
    if (!mediaSrc) {
      mediaSrc = c.createMediaElementSource(video);
      mediaSrc.connect(origGain);
    }
    const dest = c.createMediaStreamDestination();
    mediaSrc.connect(dest); // capture before ducking
    attachMeter(mediaSrc);
    if (video.paused) video.play();
    return dest.stream;
  }
  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
    // suppressLocalAudioPlayback: true also silenced LiveDub's own output on Chrome/Windows, so the dub
    // was inaudible while sharing. Users mute the shared tab instead (Chrome still captures a muted tab).
    preferCurrentTab: false,
    selfBrowserSurface: "exclude", // never capture LiveDub itself (that made the dub get re-translated in a loop)
    surfaceSwitching: "exclude", // no "Share this tab instead" button, which could switch the capture to LiveDub itself
    systemAudio: "exclude",
    windowAudio: "exclude",
    monitorTypeSurfaces: "exclude",
  });
  const tracks = displayStream.getAudioTracks();
  if (!tracks.length) {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
    throw new Error("No audio shared — pick a Chrome tab and keep “Also share tab audio” on");
  }
  const vt = displayStream.getVideoTracks()[0];
  // Only a single Chrome tab works: a window or screen shares *system* audio, which includes LiveDub's own
  // English voice (it gets re-dubbed in a loop), and silencing it mutes the dub too.
  if (vt.getSettings().displaySurface !== "browser") {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
    throw new Error("Please share a Chrome tab (the “Chrome tab” section), not a window or the entire screen");
  }
  vt.onended = () => running && stop();
  video.removeAttribute("src");
  video.srcObject = new MediaStream(displayStream.getVideoTracks());
  video.muted = true;
  video.play();
  $("#placeholder").classList.add("hidden");
  const s = new MediaStream(tracks);
  tabSrc = c.createMediaStreamSource(s);
  tabSrc.connect(origGain);
  attachMeter(tabSrc);
  return s;
}
function attachMeter(node) {
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  node.connect(analyser);
}
const buf = new Float32Array(1024);
function rms() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0; for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

function setOriginalVolume(v) {
  if (origGain) origGain.gain.setTargetAtTime(v * baseVolume(), ctx.currentTime, 0.15);
}

// ---------- picture-in-picture widget ----------
// Document Picture-in-Picture: an always-on-top mini window with just the English captions and Start/Stop.
let pip = null;
const PIP_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { background: #0e1014; color: #e8ebf1; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .caps { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px 16px; }
  #en { font-size: clamp(16px, 5.5vw, 30px); font-weight: 600; }
  #en:empty::before { content: "English captions appear here"; color: #8a93a6; font-weight: 400; font-size: 14px; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid #262b36; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #8a93a6; flex: none; }
  .dot.on { background: #ff4d6d; box-shadow: 0 0 6px #ff4d6d; }
  #st { flex: 1; color: #8a93a6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #st.err { color: #ff4d6d; }
  button { background: #232836; color: #e8ebf1; border: 1px solid #262b36; border-radius: 7px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px; }
`;
$("#pipBtn").onclick = () => openPip();
async function openPip() {
  if (pip) return pip.focus();
  if (!("documentPictureInPicture" in window)) return status("Pop-out needs Chrome or Edge 116+", "err");
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 480, height: 180 });
  } catch (e) { return status("Pop-out failed: " + e.message, "err"); }
  const d = pip.document;
  d.title = "LiveDub";
  d.head.innerHTML = `<style>${PIP_CSS}</style>`;
  d.body.innerHTML = `<div class="caps"><div id="en"></div></div>
    <div class="bar"><span class="dot"></span><span id="st"></span><button id="pt">🔊 Test</button><button id="ss">Start</button></div>`;
  d.getElementById("ss").onclick = () => { pipAudio(); running ? stop() : $("#startBtn").click(); };
  d.getElementById("pt").onclick = () => beep(pipAudio(), "pip-test-beep");
  pip.addEventListener("pagehide", () => { pip = null; pipCtx = null; });
  pipAudio();
  syncPip();
}
function syncPip() {
  if (!pip) return;
  const d = pip.document;
  d.querySelector(".dot").classList.toggle("on", running);
  d.getElementById("ss").textContent = running ? "Stop" : "Start";
  d.getElementById("st").textContent = $("#status").textContent;
  d.getElementById("st").className = $("#status").classList.contains("err") ? "err" : "";
  d.getElementById("en").textContent = $("#capEn").textContent;
}

// ---------- pipeline ----------
let running = false, recorder = null, chunkTimer = null, meterTimer = null, startedAt = 0, segIdx = 0;
let peak = 0, chain = Promise.resolve();
const history = [], segments = [];

function status(t, cls = "") { const s = $("#status"); s.textContent = t; s.className = "status " + cls; syncPip(); }

$("#startBtn").onclick = async () => {
  dubContext();
  const c = cfg();
  try {
    capStream = await getCaptureStream();
  } catch (e) { return status(e.message, "err"); }
  running = true; startedAt = performance.now();
  $("#startBtn").disabled = true; $("#stopBtn").disabled = false;
  status("Listening…", "live");
  meterTimer = setInterval(() => {
    const r = rms(); peak = Math.max(peak, r);
    $("#level").style.width = Math.min(100, r * 400) + "%";
  }, 80);
  recordChunk();
  syncPip();
};
$("#stopBtn").onclick = () => stop();

function stop() {
  running = false;
  clearTimeout(chunkTimer); clearInterval(meterTimer);
  if (recorder?.state === "recording") recorder.stop();
  displayStream?.getTracks().forEach((t) => t.stop()); displayStream = null;
  try { dubNode?.stop(); } catch {}
  tabSrc?.disconnect(); tabSrc = null;
  if (mode === "file") video.pause();
  else { video.srcObject = null; $("#placeholder").classList.remove("hidden"); }
  $("#startBtn").disabled = false; $("#stopBtn").disabled = true;
  $("#level").style.width = "0";
  status("Stopped");
}

// Each chunk gets its own MediaRecorder so every blob is a standalone, decodable file.
function recordChunk() {
  if (!running) return;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(capStream, mime ? { mimeType: mime } : undefined);
  const parts = [], t0 = (performance.now() - startedAt) / 1000;
  peak = 0;
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = () => {
    const loud = peak;
    if (running) recordChunk(); // start next chunk immediately
    if (loud < 0.01) return; // silence, skip
    handleChunk(new Blob(parts, { type: rec.mimeType }), t0, (performance.now() - startedAt) / 1000);
  };
  rec.start();
  recorder = rec;
  chunkTimer = setTimeout(() => rec.state === "recording" && rec.stop(), cfg().chunk * 1000);
}

async function api(path, opts, json = true) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { stop(); setUser(null); }
    throw new Error(j.error || r.statusText);
  }
  return json ? r.json() : r.blob();
}

function handleChunk(blob, t0, t1) {
  const c = cfg(), id = ++segIdx, sent = performance.now();
  // Work starts in parallel; results are shown/played in order through `chain`.
  const work = (async () => {
    const stt = await api(`/api/stt?lang=${c.lang}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    if (!stt.text || stt.text.length < 2) return null;
    if (isOwnDub(stt.text)) return null; // our own dub leaking back in
    const tr = await api("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: stt.text, source: stt.language || c.lang, context: history.slice(-3) }),
    });
    if (!tr.text) return null;
    history.push(stt.text);
    const audio = c.dub ? await api("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: tr.text, voiceId: c.voice }),
    }, false).catch((e) => (status("TTS: " + e.message, "err"), null)) : null;
    return { id, t0, t1, orig: stt.text, lang: stt.language, en: tr.text, origUrl: URL.createObjectURL(blob),
      dubUrl: audio && URL.createObjectURL(audio), latency: (performance.now() - sent) / 1000 };
  })().catch((e) => { status(e.message, "err"); return null; });

  chain = chain.then(async () => {
    const seg = await work;
    if (!seg) return;
    segments.push(seg);
    addSegmentCard(seg);
    showCaption(seg);
    if (seg.dubUrl) { rememberDub(seg.en); await playDub(seg); }
  });
}

function showCaption(seg) {
  $("#capEn").textContent = seg.en;
  $("#capOrig").textContent = cfg().showOrig ? seg.orig : "";
  syncPip();
  clearTimeout(showCaption.t);
  showCaption.t = setTimeout(() => { $("#capEn").textContent = ""; $("#capOrig").textContent = ""; syncPip(); }, 9000);
}

// The dub plays through the (already running) AudioContext rather than an <audio> element:
// Chrome defers <audio> playback in background tabs, so the voice only came out once LiveDub regained focus.
let dubNode = null;
// Repeat filter: drop a transcript that is mostly words LiveDub itself just spoke (the dub leaking into the capture).
const recentDubs = [];
const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
function isOwnDub(text) {
  const w = words(text);
  if (w.length < 2) return false;
  return recentDubs.some((d) => {
    const set = new Set(words(d));
    return w.filter((x) => set.has(x)).length / w.length >= 0.6;
  });
}
function rememberDub(text) {
  recentDubs.push(text);
  if (recentDubs.length > 6) recentDubs.shift();
}
// Separate AudioContext for the English voice, never connected to the captured tab's audio.
let dubCtx = null;
// The English voice plays from the pop-out window when it is open: Chrome silences the LiveDub tab's own
// output while it shares another tab with suppressLocalAudioPlayback, but the pop-out is a separate window.
let pipCtx = null;
function pipAudio() {
  if (!pip) return null;
  pipCtx ??= new pip.AudioContext({ latencyHint: "playback" });
  if (pipCtx.state !== "running") pipCtx.resume();
  return pipCtx;
}
function beep(c, ev) {
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = 660; g.gain.value = 0.2;
  o.connect(g).connect(c.destination);
  o.start(); o.stop(c.currentTime + 0.6);
}
function dubContext() {
  const pc = pipAudio();
  if (pc) return pc;
  dubCtx ??= new AudioContext({ latencyHint: "playback" });
  if (dubCtx.state !== "running") dubCtx.resume();
  return dubCtx;
}
async function playDub(seg) {
  const c = dubContext();
  let buffer;
  try {
    buffer = await c.decodeAudioData(await (await fetch(seg.dubUrl)).arrayBuffer());
  } catch { return; }
  if (!running) return;
  return new Promise((res) => {
    const backlog = segIdx - seg.id;           // catch up if we're falling behind
    const node = c.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = backlog > 1 ? 1.25 : backlog > 0 ? 1.1 : 1;
    node.connect(c.destination);
    setOriginalVolume(cfg().duck);
    mark(seg.id, true);
    node.onended = () => { if (dubNode === node) dubNode = null; setOriginalVolume(1); mark(seg.id, false); res(); };
    dubNode = node;
    node.start();
  });
}

// ---------- compare panel ----------
const fmt = (s) => { const m = Math.floor(s / 60), x = (s % 60).toFixed(1).padStart(4, "0"); return `${m}:${x}`; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function addSegmentCard(seg) {
  $("#segments .empty")?.remove();
  const el = document.createElement("div");
  el.className = "seg"; el.id = "seg" + seg.id;
  el.innerHTML = `
    <div class="meta"><span>#${seg.id} · ${fmt(seg.t0)}–${fmt(seg.t1)} · ${esc(seg.lang || "?")}</span><span>${seg.latency.toFixed(1)}s latency</span></div>
    <div class="cols"><div class="orig">${esc(seg.orig)}</div><div class="en">${esc(seg.en)}</div></div>
    <div class="btns"><button class="small" data-a="orig">▶ Original</button>${seg.dubUrl ? '<button class="small" data-a="dub">▶ English dub</button>' : ""}</div>`;
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const a = new Audio(b.dataset.a === "orig" ? seg.origUrl : seg.dubUrl); a.play();
  }));
  const box = $("#segments");
  box.prepend(el);
}
function mark(id, on) { $("#seg" + id)?.classList.toggle("playing", on); }

$("#exportBtn").onclick = () => {
  const t = (s) => { const d = new Date(s * 1000).toISOString(); return d.substr(11, 8) + "," + d.substr(20, 3); };
  const srt = segments.map((s, i) => `${i + 1}\n${t(s.t0)} --> ${t(s.t1)}\n${s.en}\n`).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([srt], { type: "text/plain" }));
  a.download = "livedub.srt"; a.click();
};

// Quick check that this page's sound reaches the speakers.
$("#testBtn").onclick = () => beep(dubContext(), "test-beep");
