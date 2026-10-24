// LiveDub server: thin proxy to ElevenLabs (speech-to-text, TTS) and Ollama Cloud (translation).
// API keys are read from .env (ELEVENLABS_API_KEY, OLLAMA_API_KEY); the browser never sees them.
const express = require("express");
const path = require("path");
const auth = require("./auth");

const MODEL = "gemma4:31b-cloud";
const OLLAMA_URL = process.env.OLLAMA_URL || "https://ollama.com/api/chat";
const EL = "https://api.elevenlabs.io/v1";
const PORT = process.env.PORT || 3000;

const app = express();
// Allow the Chrome extension (and other local pages) to call the API.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));
auth.routes(app);

const KEYS = { "x-eleven-key": "ELEVENLABS_API_KEY", "x-ollama-key": "OLLAMA_API_KEY" };
const need = (req, res, h) => {
  const v = process.env[KEYS[h]];
  if (!v) res.status(500).json({ error: `${KEYS[h]} is not set in .env` });
  return v;
};

async function relayError(res, r, who) {
  const body = await r.text();
  res.status(r.status).json({ error: `${who} ${r.status}: ${body.slice(0, 400)}` });
}

// Speech-to-text: raw audio chunk in, { text, language } out.
app.post("/api/stt", auth.requireUser, express.raw({ type: () => true, limit: "25mb" }), async (req, res) => {
  const key = need(req, res, "x-eleven-key");
  if (!key) return;
  try {
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([req.body], { type: req.get("content-type") || "audio/webm" }), "chunk.webm");
    const lang = req.query.lang;
    if (lang && lang !== "auto") form.append("language_code", lang);
    form.append("tag_audio_events", "false");
    const r = await fetch(`${EL}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form });
    if (!r.ok) return relayError(res, r, "ElevenLabs STT");
    const j = await r.json();
    res.json({ text: (j.text || "").trim(), language: j.language_code || "" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Translation via Ollama Cloud, gemma4:31b-cloud only.
app.post("/api/translate", auth.requireUser, async (req, res) => {
  const key = need(req, res, "x-ollama-key");
  if (!key) return;
  const { text, source, context = [] } = req.body || {};
  if (!text) return res.json({ text: "" });
  const sys =
    "You are a live dubbing translator. Translate the user's speech transcript into natural, spoken English " +
    "suitable for a voiceover. Keep it concise, keep names, and match the tone. " +
    "Output ONLY the English translation, no quotes, notes or explanations. " +
    "If the text is already English, return it lightly cleaned up.";
  const ctx = context.length ? `Previous lines (for context only, do not translate):\n${context.join("\n")}\n\n` : "";
  try {
    const r = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `${ctx}Source language: ${source || "auto-detect"}\nTranslate:\n${text}` },
        ],
      }),
    });
    if (!r.ok) return relayError(res, r, "Ollama");
    const j = await r.json();
    res.json({ text: (j.message?.content || "").trim() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Text-to-speech: returns audio/mpeg.
app.post("/api/tts", auth.requireUser, async (req, res) => {
  const key = need(req, res, "x-eleven-key");
  if (!key) return;
  const { text, voiceId = "JBFqnCBsd6RMkjVDRZzb", speed = 1.0 } = req.body || {};
  try {
    const r = await fetch(`${EL}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      }),
    });
    if (!r.ok) return relayError(res, r, "ElevenLabs TTS");
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/voices", auth.requireUser, async (req, res) => {
  const key = need(req, res, "x-eleven-key");
  if (!key) return;
  const r = await fetch(`${EL}/voices`, { headers: { "xi-api-key": key } });
  if (!r.ok) return relayError(res, r, "ElevenLabs voices");
  const j = await r.json();
  res.json((j.voices || []).map((v) => ({ id: v.voice_id, name: v.name })));
});

app.get("/api/health", (req, res) =>
  res.json({ elevenlabs: !!process.env.ELEVENLABS_API_KEY, ollama: !!process.env.OLLAMA_API_KEY, model: MODEL }));

app.listen(PORT, () => console.log(`LiveDub running at http://localhost:${PORT}`));
