// LiveDub client: capture audio -> chunk -> STT -> translate -> TTS -> captions + voiceover.
const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- settings ----------
const S = ["voice", "lang", "chunk", "duck"];
const CHECKS = ["showOrig", "dubOn"];
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
});
loadSettings();
$("#settingsBtn").onclick = () => $("#settings").showModal();
$("#settings").addEventListener("close", saveSettings);
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
  if (!h.elevenlabs || !h.ollama) status("Server is missing API keys — fill in .env and restart", "err");
}).catch(() => {});

// ---------- source modes ----------
let mode = "file";
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  if (running) stop();
  mode = b.dataset.mode;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".source").forEach((s) => s.classList.toggle("hidden", s.dataset.src !== mode));
  $("#video").classList.toggle("hidden", mode === "youtube");
  $("#yt").classList.toggle("hidden", mode !== "youtube");
  $("#video").controls = mode === "file";
  $("#placeholder").classList.toggle("hidden", mode === "youtube" && !!ytPlayer);
}));

const video = $("#video");
$("#fileInput").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  video.srcObject = null;
  video.src = URL.createObjectURL(f);
  video.muted = false;
  $("#placeholder").classList.add("hidden");
};

let ytPlayer = null;
function ytId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : /^[\w-]{11}$/.test(url) ? url : null;
}
$("#ytLoad").onclick = () => {
  const id = ytId($("#ytUrl").value.trim());
  if (!id) return alert("That doesn't look like a YouTube URL");
  $("#placeholder").classList.add("hidden");
  if (ytPlayer) return ytPlayer.loadVideoById(id);
  ytPlayer = new YT.Player("yt", { videoId: id, playerVars: { playsinline: 1, cc_load_policy: 0 } });
};

// ---------- audio graph ----------
let ctx, mediaSrc, origGain, analyser, capStream, displayStream;
function audioCtx() {
  ctx ??= new AudioContext();
  ctx.resume();
  return ctx;
}
async function getCaptureStream() {
  const c = audioCtx();
  if (mode === "file") {
    if (!video.src) throw new Error("Choose a video file first");
    if (!mediaSrc) {
      mediaSrc = c.createMediaElementSource(video);
      origGain = c.createGain();
      mediaSrc.connect(origGain).connect(c.destination);
    }
    const dest = c.createMediaStreamDestination();
    mediaSrc.connect(dest); // capture before ducking
    attachMeter(mediaSrc);
    if (video.paused) video.play();
    return dest.stream;
  }
  // youtube (this tab) or another tab / call
  const opts = {
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    systemAudio: "include",
    restrictOwnAudio: true, // keep our own dub out of the capture (Chrome)
  };
  if (mode === "youtube") opts.preferCurrentTab = true;
  else opts.selfBrowserSurface = "exclude";
  displayStream = await navigator.mediaDevices.getDisplayMedia(opts);
  const tracks = displayStream.getAudioTracks();
  if (!tracks.length) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new Error("No audio shared — tick “Share tab audio” in the picker");
  }
  displayStream.getVideoTracks()[0].onended = () => running && stop();
  if (mode === "tab") {
    video.removeAttribute("src");
    video.srcObject = new MediaStream(displayStream.getVideoTracks());
    video.muted = true;
    video.play();
    $("#placeholder").classList.add("hidden");
  }
  if (mode === "youtube" && ytPlayer?.playVideo) ytPlayer.playVideo();
  const s = new MediaStream(tracks);
  attachMeter(c.createMediaStreamSource(s));
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
  if (mode === "file" && origGain) origGain.gain.setTargetAtTime(v, ctx.currentTime, 0.15);
  if (mode === "youtube" && ytPlayer?.setVolume) ytPlayer.setVolume(Math.round(v * 100));
}

// ---------- pipeline ----------
let running = false, recorder = null, chunkTimer = null, meterTimer = null, startedAt = 0, segIdx = 0;
let peak = 0, chain = Promise.resolve();
const history = [], segments = [];

function status(t, cls = "") { const s = $("#status"); s.textContent = t; s.className = "status " + cls; }

$("#startBtn").onclick = async () => {
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
};
$("#stopBtn").onclick = () => stop();

function stop() {
  running = false;
  clearTimeout(chunkTimer); clearInterval(meterTimer);
  if (recorder?.state === "recording") recorder.stop();
  displayStream?.getTracks().forEach((t) => t.stop()); displayStream = null;
  if (mode === "file") video.pause();
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
    if (loud < 0.01) return;     // silence, skip
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
    if (seg.dubUrl) await playDub(seg);
  });
}

function showCaption(seg) {
  $("#capEn").textContent = seg.en;
  $("#capOrig").textContent = cfg().showOrig ? seg.orig : "";
  clearTimeout(showCaption.t);
  showCaption.t = setTimeout(() => { $("#capEn").textContent = ""; $("#capOrig").textContent = ""; }, 9000);
}

const dubAudio = new Audio();
function playDub(seg) {
  return new Promise((res) => {
    const backlog = segIdx - seg.id;           // catch up if we're falling behind
    dubAudio.src = seg.dubUrl;
    dubAudio.playbackRate = backlog > 1 ? 1.25 : backlog > 0 ? 1.1 : 1;
    setOriginalVolume(cfg().duck);
    mark(seg.id, true);
    const done = () => { setOriginalVolume(1); mark(seg.id, false); res(); };
    dubAudio.onended = done; dubAudio.onerror = done;
    dubAudio.play().catch(done);
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
