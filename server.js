require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT) || 3000;
const MAX_PEOPLE = 30;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://mfkvitmdctpcqrkdfsrj.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";
const IP_HASH_KEY = process.env.IP_HASH_SECRET || ADMIN_SECRET || SUPABASE_KEY;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

if (!SUPABASE_KEY) {
  console.error("Set SUPABASE_ANON_KEY in .env.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

let mutateQueue = Promise.resolve();

function enqueue(work) {
  const run = mutateQueue.then(work, work);
  mutateQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function clientIp(req) {
  const ip = req.ip || req.socket.remoteAddress || "";
  return ip.replace(/^::ffff:/, "");
}

function sessionToken(req, res) {
  const cookies = String(req.headers.cookie || "").split(";");
  const saved = cookies.map((part) => part.trim()).find((part) => part.startsWith("santa_session="));
  const token = saved && saved.slice("santa_session=".length);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    return token;
  }

  const fresh = crypto.randomBytes(32).toString("base64url");
  const secure = process.env.NODE_ENV === "production" || req.secure;
  res.append(
    "Set-Cookie",
    `santa_session=${fresh}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
  return fresh;
}

function hashSession(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashIp(ip) {
  return crypto.createHmac("sha256", IP_HASH_KEY).update(ip).digest("hex");
}

function ipAllowed(req, res, next) {
  if (ALLOWED_IPS.length === 0) {
    return next();
  }
  const ip = clientIp(req);
  if (ALLOWED_IPS.includes(ip)) {
    return next();
  }
  return res.status(403).json({ error: "This draw is locked to allowed networks." });
}

app.use("/api", ipAllowed);

function dbError(err) {
  const message = String((err && err.message) || err || "");
  if (message.includes("DRAW_FULL")) {
    return { status: 409, error: "The draw is full (30 people)." };
  }
  if (message.includes("DRAW_CLOSED")) {
    return { status: 409, error: "Names are locked. Matching has already started." };
  }
  if (message.includes("NEED_TWO")) {
    return { status: 400, error: "Need at least 2 names before matching." };
  }
  if (message.includes("ALREADY_DRAWN")) {
    return { status: 409, error: "Names were already drawn." };
  }
  if (message.includes("BAD_SECRET")) {
    return { status: 403, error: "Wrong host secret." };
  }
  if (message.includes("ALREADY_MATCHED")) {
    return { status: 409, error: "That person has already been matched." };
  }
  if (message.includes("NO_MATCH_CANDIDATE")) {
    return { status: 409, error: "No valid one-to-one match is available." };
  }
  if (message.includes("BAD_PERSON_ID")) {
    return { status: 400, error: "Choose a name from the list." };
  }
  if (err && err.code === "23505") {
    return { status: 409, error: "That name is already in the draw." };
  }
  console.error("Supabase error:", err);
  return { status: 500, error: "Could not reach the draw." };
}

async function getDraw() {
  const { data, error } = await supabase.from("draw").select("drawn, drawn_at").eq("id", 1).single();
  if (error) {
    throw error;
  }
  return data;
}

async function listUnmatchedPeople() {
  const { data, error } = await supabase.rpc("list_available_people");
  if (error) {
    throw error;
  }
  return data || [];
}

async function listDrawRoster() {
  const { data, error } = await supabase.rpc("list_draw_roster");
  if (error) {
    throw error;
  }
  return data || [];
}

app.get("/api/status", (req, res) => {
  const sessionHash = hashSession(sessionToken(req, res));
  enqueue(async () => {
    const [draw, available, roster, sessionResult] = await Promise.all([
      getDraw(),
      listUnmatchedPeople(),
      listDrawRoster(),
      supabase.rpc("get_session_match", { p_session_hash: sessionHash }),
    ]);
    if (sessionResult.error) {
      throw sessionResult.error;
    }
    return res.json({
      remaining: available.length,
      total: roster.length,
      max: MAX_PEOPLE,
      drawn: Boolean(draw.drawn),
      names: roster.map(({ id, name }) => ({ id, name })),
      availableNames: draw.drawn ? [] : available.map(({ id, name }) => ({ id, name })),
      sessionMatch: sessionResult.data,
    });
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/match", (req, res) => {
  const sessionHash = hashSession(sessionToken(req, res));
  const ipHash = hashIp(clientIp(req));
  enqueue(async () => {
    const personId = String((req.body && req.body.personId) || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(personId)) {
      return res.status(400).json({ error: "Choose a name from the list." });
    }

    const { data, error } = await supabase.rpc("match_one", {
      p_person_id: personId,
      p_session_hash: sessionHash,
      p_ip_hash: ipHash,
    });
    if (error) {
      const mapped = dbError(error);
      return res.status(mapped.status).json({ error: mapped.error });
    }
    if (data && data.error === "RATE_LIMITED") {
      return res.status(429).json({ error: "Too many matches from this network. Try again later." });
    }
    return res.json(data);
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/reset", (req, res) => {
  const secret = (req.body && req.body.secret) || req.get("x-admin-secret") || ADMIN_SECRET;
  enqueue(async () => {
    const { error } = await supabase.rpc("reset_draw", { p_secret: secret });
    if (error) {
      const mapped = dbError(error);
      return res.status(mapped.status).json({ error: mapped.error });
    }
    return res.json({ ok: true });
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.listen(PORT, () => {
  console.log(`Secret Santa running at http://localhost:${PORT}`);
});
