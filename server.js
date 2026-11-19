require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT) || 3000;
const MAX_PEOPLE = 50;
const BASKET_CODE_PATTERN = /^[a-z0-9]{10}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASKET_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
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
app.get("/b/:code", (req, res, next) => {
  if (!BASKET_CODE_PATTERN.test(req.params.code)) return res.status(404).send("Basket not found.");
  return res.sendFile(path.join(__dirname, "public", "index.html"), (err) => err && next(err));
});
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function runAsync(work) {
  // Let independent baskets run concurrently; PostgreSQL owns per-basket locking.
  return Promise.resolve().then(work);
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
  if (err && [429, 502, 503, 504].includes(Number(err.status))) {
    return { status: 503, error: "The draw service is busy. Please try again shortly." };
  }
  if (message.includes("DRAW_FULL")) {
    return { status: 409, error: "This basket has reached its participant limit." };
  }
  if (message.includes("DRAW_CLOSED")) {
    return { status: 409, error: "This basket has already launched." };
  }
  if (message.includes("NEED_TWO")) return { status: 400, error: "At least two people must join before the draw can launch." };
  if (message.includes("DRAW_NOT_FULL")) {
    return { status: 409, error: "Every participant place must be filled before launch." };
  }
  if (message.includes("ALREADY_DRAWN")) {
    return { status: 409, error: "Names were already drawn." };
  }
  if (message.includes("BAD_SECRET")) {
    return { status: 403, error: "Wrong host secret." };
  }
  if (message.includes("BASKET_NOT_FOUND")) return { status: 404, error: "This basket link is no longer available." };
  if (message.includes("BAD_BASKET") || message.includes("BAD_NAME")) return { status: 400, error: "Check the basket details and try again." };
  if (message.includes("ALREADY_MATCHED")) {
    return { status: 409, error: "That person has already been matched." };
  }
  if (message.includes("NO_MATCH_CANDIDATE")) {
    return { status: 409, error: "No valid one-to-one match is available." };
  }
  if (message.includes("BAD_PERSON_ID")) {
    return { status: 400, error: "Choose a name from the list." };
  }
  if (message.includes("BAD_SESSION")) {
    return { status: 400, error: "Your browser session could not be verified. Refresh and try again." };
  }
  if (err && err.code === "23505") {
    return { status: 409, error: "That name is already in the draw." };
  }
  console.error("Supabase error:", err);
  return { status: 500, error: "Could not reach the draw." };
}

async function listUnmatchedPeople(basketId, sessionHash) {
  const { data, error } = await supabase.rpc("list_available_people", { p_basket_id: basketId, p_session_hash: sessionHash });
  if (error) {
    throw error;
  }
  return data || [];
}

async function listDrawRoster(basketId) {
  const { data, error } = await supabase.rpc("list_draw_roster", { p_basket_id: basketId });
  if (error) {
    throw error;
  }
  return data || [];
}

function getBasketStatus(basketRef, sessionHash) {
  return UUID_PATTERN.test(basketRef)
    ? supabase.rpc("basket_status", { p_basket_id: basketRef })
    : supabase.rpc("basket_status_by_code", { p_public_code: basketRef, p_session_hash: sessionHash });
}

function validBasketRef(value) {
  return UUID_PATTERN.test(value) || BASKET_CODE_PATTERN.test(value);
}

app.get("/api/status", (req, res) => {
  const basketRef = String(req.query.basket || "");
  const hostView = req.query.hostView === "1";
  if (!validBasketRef(basketRef)) return res.status(400).json({ error: "Choose a valid basket." });
  const sessionHash = hashSession(sessionToken(req, res));
  runAsync(async () => {
    const basketResult = await getBasketStatus(basketRef, sessionHash);
    if (basketResult.error) throw basketResult.error;
    if (!basketResult.data) return res.status(404).json({ error: "This basket link is no longer available." });
    const basket = basketResult.data;
    const [available, roster, sessionResult] = await Promise.all([
      listUnmatchedPeople(basket.id, sessionHash),
      listDrawRoster(basket.id),
      supabase.rpc("get_session_match", { p_basket_id: basket.id, p_session_hash: sessionHash }),
    ]);
    if (sessionResult.error) {
      throw sessionResult.error;
    }
    return res.json({
      remaining: available.length,
      total: roster.length,
      max: MAX_PEOPLE,
      basket,
      drawn: Boolean(basket.drawn),
      launched: Boolean(basket.launched),
      names: roster.map(({ id, name }) => ({ id, name })),
      availableNames: basket.drawn || !basket.launched ? [] : available.map(({ id, name }) => ({ id, name })),
      sessionMatch: hostView ? null : sessionResult.data,
    });
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/match", (req, res) => {
  const sessionHash = hashSession(sessionToken(req, res));
  const ipHash = hashIp(clientIp(req));
  runAsync(async () => {
    const personId = String((req.body && req.body.personId) || "").trim();
    const basketRef = String((req.body && (req.body.basket || req.body.basketId)) || "");
    if (!UUID_PATTERN.test(personId) || !validBasketRef(basketRef)) {
      return res.status(400).json({ error: "Choose a name from the list." });
    }

    const basketResult = await getBasketStatus(basketRef, sessionHash);
    if (basketResult.error) { const mapped = dbError(basketResult.error); return res.status(mapped.status).json({ error: mapped.error }); }
    if (!basketResult.data) return res.status(404).json({ error: "This basket link is no longer available." });

    const { data, error } = await supabase.rpc("match_one", {
      p_basket_id: basketResult.data.id,
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

app.post("/api/baskets", (req, res) => {
  runAsync(async () => {
    const hostName = String((req.body && req.body.hostName) || "").trim();
    const hostEmail = String((req.body && req.body.hostEmail) || "").trim().toLowerCase();
    const hostPin = String((req.body && req.body.hostPin) || "").trim();
    const capacity = Number(req.body && req.body.capacity);
    if (!hostName || hostName.length > 80 || !Number.isInteger(capacity) || capacity < 2 || capacity > MAX_PEOPLE) {
      return res.status(400).json({ error: "Add a host name and choose 2–50 participants." });
    }
    if (hostEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hostEmail)) {
      return res.status(400).json({ error: "Enter a valid host email address." });
    }
    if (!/^\d{4}$/.test(hostPin)) return res.status(400).json({ error: "Choose a 4-digit host PIN." });
    const sessionHash = hashSession(sessionToken(req, res));
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const publicCode = Array.from(crypto.randomBytes(10), (byte) => BASKET_CODE_ALPHABET[byte % BASKET_CODE_ALPHABET.length]).join("");
      const origin = PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`;
      const storedLink = new URL(`/b/${publicCode}`, origin).toString();
      result = await supabase.rpc("create_basket", {
        p_host_name: hostName,
        p_capacity: capacity,
        p_session_hash: sessionHash,
        p_public_code: publicCode,
        p_host_email: hostEmail,
        p_host_pin: hostPin,
        p_stored_link: storedLink,
      });
      if (!result.error || result.error.code !== "23505") break;
    }
    if (result.error) {
      if (result.error.code === "23505") return res.status(503).json({ error: "Could not reserve an invite code. Please try again." });
      const mapped = dbError(result.error);
      return res.status(mapped.status).json({ error: mapped.error });
    }
    res.status(201).json(result.data);
  }).catch((err) => { const mapped = dbError(err); res.status(mapped.status).json({ error: mapped.error }); });
});

app.post("/api/host/verify", (req, res) => {
  const sessionHash = hashSession(sessionToken(req, res));
  runAsync(async () => {
    const basketCode = String((req.body && req.body.basket) || "");
    const hostEmail = String((req.body && req.body.hostEmail) || "").trim().toLowerCase();
    const hostPin = String((req.body && req.body.hostPin) || "").trim();
    if (!BASKET_CODE_PATTERN.test(basketCode) || hostEmail.length > 254 || !/^\d{4}$/.test(hostPin)) {
      return res.status(400).json({ error: "Enter the host email and 4-digit PIN." });
    }
    const { data, error } = await supabase.rpc("verify_basket_host", {
      p_public_code: basketCode,
      p_host_email: hostEmail,
      p_host_pin: hostPin,
      p_session_hash: sessionHash,
    });
    if (error) { const mapped = dbError(error); return res.status(mapped.status).json({ error: mapped.error }); }
    if (data && data.error === "PIN_RATE_LIMITED") {
      return res.status(429).json({ error: "Too many PIN attempts. Please wait 15 minutes and try again." });
    }
    if (data && data.error === "BAD_HOST_CREDENTIALS") {
      return res.status(403).json({ error: "That email and PIN don’t match this basket." });
    }
    return res.json({ ok: true });
  }).catch((err) => { const mapped = dbError(err); res.status(mapped.status).json({ error: mapped.error }); });
});

app.post("/api/host/baskets", (req, res) => {
  const sessionHash = hashSession(sessionToken(req, res));
  runAsync(async () => {
    const hostEmail = String((req.body && req.body.hostEmail) || "").trim().toLowerCase();
    const hostPin = String((req.body && req.body.hostPin) || "").trim();
    if (hostEmail.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(hostEmail) || !/^\\d{4}$/.test(hostPin)) {
      return res.status(400).json({ error: "Enter the host email and 4-digit PIN." });
    }
    const { data, error } = await supabase.rpc("list_host_baskets", {
      p_host_email: hostEmail,
      p_host_pin: hostPin,
      p_session_hash: sessionHash,
    });
    if (error) { const mapped = dbError(error); return res.status(mapped.status).json({ error: mapped.error }); }
    if (data && data.error === "PIN_RATE_LIMITED") {
      return res.status(429).json({ error: "Too many PIN attempts. Please wait 15 minutes and try again." });
    }
    if (!Array.isArray(data) || !data.length) {
      return res.status(403).json({ error: "No baskets match that email and PIN." });
    }
    return res.json({ baskets: data });
  }).catch((err) => { const mapped = dbError(err); res.status(mapped.status).json({ error: mapped.error }); });
});

app.post("/api/join", (req, res) => {
  runAsync(async () => {
    const basketRef = String((req.body && (req.body.basket || req.body.basketId)) || "");
    const name = String((req.body && req.body.name) || "").trim();
    if (!validBasketRef(basketRef) || !name || name.length > 80) return res.status(400).json({ error: "Enter your name to join." });
    const sessionHash = hashSession(sessionToken(req, res));
    const basketResult = await getBasketStatus(basketRef, sessionHash);
    if (basketResult.error) { const mapped = dbError(basketResult.error); return res.status(mapped.status).json({ error: mapped.error }); }
    if (!basketResult.data) return res.status(404).json({ error: "This basket link is no longer available." });
    const { data, error } = await supabase.rpc("join_basket", { p_basket_id: basketResult.data.id, p_name: name, p_session_hash: sessionHash });
    if (error) { const mapped = dbError(error); return res.status(mapped.status).json({ error: mapped.error }); }
    res.status(201).json(data);
  }).catch((err) => { const mapped = dbError(err); res.status(mapped.status).json({ error: mapped.error }); });
});

app.post("/api/launch", (req, res) => {
  runAsync(async () => {
    const basketRef = String((req.body && (req.body.basket || req.body.basketId)) || "");
    const legacySecret = String((req.body && req.body.hostSecret) || "");
    if (!validBasketRef(basketRef)) return res.status(400).json({ error: "Choose a valid basket." });
    const sessionHash = hashSession(sessionToken(req, res));
    const basketResult = await getBasketStatus(basketRef, sessionHash);
    if (basketResult.error) { const mapped = dbError(basketResult.error); return res.status(mapped.status).json({ error: mapped.error }); }
    if (!basketResult.data) return res.status(404).json({ error: "This basket link is no longer available." });
    const hostCredential = basketResult.data.hostAccess ? sessionHash : legacySecret;
    const { data, error } = await supabase.rpc("launch_basket", { p_basket_id: basketResult.data.id, p_host_secret: hostCredential });
    if (error) { const mapped = dbError(error); return res.status(mapped.status).json({ error: mapped.error }); }
    res.json(data);
  }).catch((err) => { const mapped = dbError(err); res.status(mapped.status).json({ error: mapped.error }); });
});

app.listen(PORT, () => {
  console.log(`Secret Santa running at http://localhost:${PORT}`);
});
