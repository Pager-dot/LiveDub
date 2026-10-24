// Email + password accounts in an in-memory Postgres (pg-mem). Everything resets when the server restarts.
const crypto = require("crypto");
const { newDb } = require("pg-mem");

const { Pool } = newDb().adapters.createPg();
const pool = new Pool();
const ready = pool.query(`
  create table users (id serial primary key, email text unique not null, hash text not null, created_at timestamptz default now());
  create table sessions (token text primary key, user_id int not null references users(id), created_at timestamptz default now());
`);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE = "livedub_session";

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verify(password, stored) {
  const [salt, h] = stored.split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function newSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("insert into sessions (token, user_id) values ($1, $2)", [token, userId]);
  res.set("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  return token;
}

function tokenFrom(req) {
  const bearer = req.get("authorization")?.match(/^Bearer (\w+)$/)?.[1];
  if (bearer) return bearer;
  return (req.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
}

async function userFor(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  await ready;
  const r = await pool.query(
    "select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token = $1", [token]);
  return r.rows[0] || null;
}

function routes(app) {
  app.post("/api/signup", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    await ready;
    try {
      const r = await pool.query("insert into users (email, hash) values ($1, $2) returning id", [email, hash(password)]);
      res.json({ email, token: await newSession(res, r.rows[0].id) });
    } catch {
      res.status(409).json({ error: "An account with that email already exists — log in instead" });
    }
  });

  app.post("/api/login", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    await ready;
    const r = await pool.query("select id, hash from users where email = $1", [email]);
    const u = r.rows[0];
    if (!u || !verify(String(req.body?.password || ""), u.hash)) return res.status(401).json({ error: "Wrong email or password" });
    res.json({ email, token: await newSession(res, u.id) });
  });

  app.post("/api/logout", async (req, res) => {
    const token = tokenFrom(req);
    if (token) await pool.query("delete from sessions where token = $1", [token]);
    res.set("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const u = await userFor(req);
    u ? res.json({ email: u.email }) : res.status(401).json({ error: "Not logged in" });
  });
}

// Guards the paid API routes.
async function requireUser(req, res, next) {
  const u = await userFor(req).catch(() => null);
  if (!u) return res.status(401).json({ error: "Please log in", auth: true });
  req.user = u;
  next();
}

module.exports = { routes, requireUser };
