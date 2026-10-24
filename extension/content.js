// LiveDub widget: caption overlay + floating, draggable panel injected into the page (Shadow DOM).
(() => {
  if (window.__liveDub) return;
  window.__liveDub = true;

  const LANGS = { auto: "Auto-detect", ja: "Japanese", es: "Spanish", fr: "French", de: "German", hi: "Hindi",
    ko: "Korean", zh: "Chinese", ru: "Russian", pt: "Portuguese", it: "Italian", ar: "Arabic" };
  let settings = { lang: "auto", chunk: 5, duck: 0.2, dub: true, showOrig: true };
  let root, $, built = false, capTimer;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, "0")}`;
  const send = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

  function build() {
    if (built) return;
    built = true;
    const host = document.createElement("div");
    host.id = "livedub-host";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
  :host { --bg: rgba(17,19,25,.94); --line: #2b3040; --text: #e8ebf1; --muted: #8a93a6; --accent: #ff4d6d; --cyan: #4dd4ff; --ok: #3ddc97; }
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
  .caps { position: fixed; left: 50%; bottom: 9%; transform: translateX(-50%); width: min(900px, 92vw); text-align: center; pointer-events: none; }
  .caps div { display: inline-block; margin-top: 4px; padding: 5px 12px; border-radius: 6px; background: rgba(0,0,0,.78); line-height: 1.35; }
  .caps div:empty { display: none; }
  #en { color: #fff; font-size: clamp(17px, 2.1vw, 26px); font-weight: 600; text-shadow: 0 1px 2px #000; }
  #orig { color: #ffd36e; font-size: clamp(13px, 1.4vw, 17px); }
  .panel { position: fixed; top: 80px; right: 20px; width: 340px; max-height: 70vh; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
    pointer-events: auto; font-size: 13px; backdrop-filter: blur(8px); }
  .panel.min .body { display: none; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move; user-select: none; border-bottom: 1px solid var(--line); }
  .panel.min .head { border-bottom: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1.4s infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .title { font-weight: 700; }
  .status { color: var(--muted); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status.err { color: var(--accent); }
  button { background: #232836; color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: 4px 9px; cursor: pointer; font-size: 12px; }
  button:hover { border-color: var(--cyan); }
  .icon { padding: 3px 7px; }
  .body { overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
  .settings { padding: 10px 12px; border-bottom: 1px solid var(--line); display: none; gap: 8px; flex-direction: column; }
  .settings.open { display: flex; }
  label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text); }
  select, input[type=range] { background: #0b0d11; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px; max-width: 160px; }
  .segs { overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .empty { color: var(--muted); }
  .seg { border: 1px solid var(--line); border-radius: 9px; padding: 8px; background: rgba(0,0,0,.25); }
  .seg.speaking { border-color: var(--cyan); }
  .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; display: flex; justify-content: space-between; }
  .o { color: #ffd36e; margin-bottom: 3px; }
  .btns { display: flex; gap: 6px; margin-top: 6px; }
  .hint { color: var(--muted); font-size: 12px; }
  .hint a { color: var(--cyan); }
  .login { display: none; flex-direction: column; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
  .login.open { display: flex; }
  .login input, #server { background: #0b0d11; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
  #server { max-width: 190px; }
  .login button { background: var(--accent); border-color: var(--accent); color: #fff; padding: 6px; }
  .err { color: var(--accent); font-size: 12px; min-height: 1em; }
</style>
<div class="caps"><div id="orig"></div><br><div id="en"></div></div>
<div class="panel" id="panel">
  <div class="head" id="head">
    <span class="dot" id="dot"></span><span class="title">LiveDub</span>
    <span class="status" id="status">Click the LiveDub icon to start</span>
    <button class="icon" id="gear" title="Settings">⚙</button>
    <button class="icon" id="min" title="Minimise">–</button>
    <button class="icon" id="close" title="Stop and close">✕</button>
  </div>
  <div class="body">
    <form class="login" id="login">
      <b id="loginTitle">Log in to LiveDub</b>
      <input id="email" type="email" placeholder="Email" required>
      <input id="pass" type="password" placeholder="Password (8+ characters)" minlength="8" required>
      <span class="err" id="loginErr"></span>
      <button id="loginBtn">Log in</button>
      <span class="hint"><a href="#" id="loginSwitch">No account? Sign up</a></span>
    </form>
    <div class="settings" id="settings">
      <label>Server URL <input id="server" type="url" placeholder="http://localhost:3000"></label>
      <label>Source language <select id="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <label>Chunk length <span><b id="chunkVal"></b>s <input id="chunk" type="range" min="3" max="12"></span></label>
      <label>Original volume while dubbing <span><b id="duckVal"></b>% <input id="duck" type="range" min="0" max="100"></span></label>
      <label>English voiceover <input id="dub" type="checkbox"></label>
      <label>Show original line <input id="showOrig" type="checkbox"></label>
      <span class="hint">Language, chunk and voiceover changes apply to the next chunk.</span>
      <label><span class="hint" id="who"></span> <button id="logout" type="button">Log out</button></label>
    </div>
    <div class="segs" id="segs"><p class="empty">Original ⇄ English lines appear here as people speak.</p></div>
  </div>
</div>`;
    $ = (s) => root.getElementById(s);

    // settings
    const sync = () => {
      $("lang").value = settings.lang; $("chunk").value = settings.chunk; $("chunkVal").textContent = settings.chunk;
      $("duck").value = Math.round(settings.duck * 100); $("duckVal").textContent = $("duck").value;
      $("dub").checked = settings.dub; $("showOrig").checked = settings.showOrig;
    };
    sync();
    const save = () => {
      settings = { lang: $("lang").value, chunk: +$("chunk").value, duck: $("duck").value / 100, dub: $("dub").checked, showOrig: $("showOrig").checked };
      sync();
      chrome.storage.local.set({ settings });
      send({ type: "settings", settings });
      if (!settings.showOrig) $("orig").textContent = "";
    };
    ["lang", "chunk", "duck", "dub", "showOrig"].forEach((id) => $(id).addEventListener("input", save));
    $("gear").onclick = () => $("settings").classList.toggle("open");
    $("min").onclick = () => $("panel").classList.toggle("min");
    $("close").onclick = () => { send({ type: "stop" }); hide(); };

    // dragging
    const panel = $("panel");
    $("head").addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        panel.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)) + "px";
        panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px";
        panel.style.right = "auto";
      };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
  }

  let signup = false;
  async function serverUrl() { return ((await chrome.storage.local.get("server")).server || "http://localhost:3000").replace(/\/$/, ""); }
  async function refreshLogin() {
    const { token, email } = await chrome.storage.local.get(["token", "email"]);
    $("login").classList.toggle("open", !token);
    $("who").textContent = email ? "Signed in as " + email : "";
    $("server").value = await serverUrl();
    if (!token) status("Log in to start dubbing");
  }
  function wireLogin() {
    $("loginSwitch").onclick = (e) => {
      e.preventDefault(); signup = !signup;
      $("loginTitle").textContent = signup ? "Create a LiveDub account" : "Log in to LiveDub";
      $("loginBtn").textContent = signup ? "Sign up" : "Log in";
      $("loginSwitch").textContent = signup ? "Have an account? Log in" : "No account? Sign up";
    };
    $("login").onsubmit = async (e) => {
      e.preventDefault(); $("loginErr").textContent = "";
      try {
        const r = await fetch((await serverUrl()) + (signup ? "/api/signup" : "/api/login"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("email").value, password: $("pass").value }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return ($("loginErr").textContent = j.error || "Something went wrong");
        await chrome.storage.local.set({ token: j.token, email: j.email });
        $("pass").value = "";
        await refreshLogin();
        status("Logged in — click the LiveDub icon to start");
      } catch { $("loginErr").textContent = "Can't reach the server — check the Server URL in ⚙"; }
    };
    $("logout").onclick = async () => {
      const { token } = await chrome.storage.local.get("token");
      send({ type: "stop" });
      fetch((await serverUrl()) + "/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      await chrome.storage.local.remove(["token", "email"]);
      refreshLogin();
    };
    $("server").addEventListener("change", async () => {
      await chrome.storage.local.set({ server: $("server").value.trim() || "http://localhost:3000" });
      await chrome.storage.local.remove(["token", "email"]); // accounts are per server
      refreshLogin();
    });
  }

  function show() { const first = !built; build(); if (first) wireLogin(); root.host.style.display = ""; refreshLogin(); }
  function hide() { if (built) root.host.style.display = "none"; }

  function status(text, err) {
    if (!built) return;
    $("status").textContent = text;
    $("status").classList.toggle("err", !!err);
  }

  function addSegment(seg) {
    root.querySelector(".empty")?.remove();
    const el = document.createElement("div");
    el.className = "seg";
    el.id = "seg" + seg.id;
    el.innerHTML = `<div class="meta"><span>${fmt(seg.t0)} · ${esc(seg.lang || "?")}</span><span>${seg.latency.toFixed(1)}s</span></div>
      <div class="o">${esc(seg.orig)}</div><div>${esc(seg.en)}</div>
      <div class="btns"><button data-k="orig">▶ Original</button>${seg.hasDub ? '<button data-k="dub">▶ English</button>' : ""}</div>`;
    el.querySelectorAll("button").forEach((b) => (b.onclick = () =>
      chrome.runtime.sendMessage({ target: "offscreen", type: "play", id: seg.id, kind: b.dataset.k }).catch(() => {})));
    $("segs").prepend(el);
    while ($("segs").children.length > 60) $("segs").lastChild.remove();

    $("en").textContent = seg.en;
    $("orig").textContent = settings.showOrig ? seg.orig : "";
    clearTimeout(capTimer);
    capTimer = setTimeout(() => { $("en").textContent = ""; $("orig").textContent = ""; }, 9000);
  }

  chrome.storage.local.get("settings").then((r) => r.settings && (settings = { ...settings, ...r.settings }));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "widget") return msg.on ? show() : hide();
    if (!built) show();
    if (msg.type === "status") status(msg.text, msg.err);
    if (msg.type === "state") {
      $("dot").classList.toggle("on", msg.running);
      if (!msg.running) status("Stopped — click the LiveDub icon to start again");
    }
    if (msg.type === "segment") { status("Listening…"); addSegment(msg.seg); }
    if (msg.type === "auth") { chrome.storage.local.remove(["token", "email"]).then(refreshLogin); status("Session expired — log in again", true); }
    if (msg.type === "speaking") root.getElementById("seg" + msg.id)?.classList.toggle("speaking", msg.on);
  });
})();
