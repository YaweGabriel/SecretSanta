require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT) || 3000;
const MAX_PEOPLE = 30;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://mfkvitmdctpcqrkdfsrj.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY in .env (Project Settings > API).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

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

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nameKey(name) {
  return normalizeName(name).toLocaleLowerCase();
}

function isFourDigitPin(pin) {
  return /^\d{4}$/.test(String(pin || ""));
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString("hex");
}

function pinsMatch(person, pin) {
  const hashed = hashPin(pin, person.pin_salt);
  const a = Buffer.from(hashed, "hex");
  const b = Buffer.from(person.pin_hash, "hex");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function adminOk(req) {
  if (!ADMIN_SECRET) {
    return false;
  }
  const provided = req.get("x-admin-secret") || (req.body && req.body.secret) || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dbError(err) {
  const message = String((err && err.message) || err || "");
  if (message.includes("DRAW_FULL")) {
    return { status: 409, error: "The draw is full (30 people)." };
  }
  if (message.includes("DRAW_CLOSED")) {
    return { status: 409, error: "Names are locked. Matching has already started." };
  }
  if (err && err.code === "23505") {
    return { status: 409, error: "That name is already in the draw." };
  }
  return { status: 500, error: "Could not reach the draw." };
}

async function getDraw() {
  const { data, error } = await supabase.from("draw").select("drawn, drawn_at").eq("id", 1).single();
  if (error) {
    throw error;
  }
  return data;
}

async function listPeople() {
  const { data, error } = await supabase
    .from("people")
    .select("id, name, name_key, pin_hash, pin_salt, match_id")
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return data || [];
}

function cycleAssignments(ids) {
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((id, index) => ({
    id,
    match_id: shuffled[(index + 1) % shuffled.length],
  }));
}

app.get("/api/status", (req, res) => {
  enqueue(async () => {
    const [draw, people] = await Promise.all([getDraw(), listPeople()]);
    return res.json({
      count: people.length,
      max: MAX_PEOPLE,
      drawn: Boolean(draw.drawn),
    });
  }).catch((err) => {
    console.error(err);
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/join", (req, res) => {
  enqueue(async () => {
    const name = normalizeName(req.body && req.body.name);
    const pin = req.body && req.body.pin;

    if (!name) {
      return res.status(400).json({ error: "Enter a name." });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: "Use a shorter name." });
    }
    if (!isFourDigitPin(pin)) {
      return res.status(400).json({ error: "Choose a 4-digit PIN." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const { error } = await supabase.from("people").insert({
      name,
      name_key: nameKey(name),
      pin_hash: hashPin(pin, salt),
      pin_salt: salt,
    });
    if (error) {
      const mapped = dbError(error);
      return res.status(mapped.status).json({ error: mapped.error });
    }

    return res.json({ status: "enrolled" });
  }).catch((err) => {
    console.error(err);
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/lookup", (req, res) => {
  enqueue(async () => {
    const name = normalizeName(req.body && req.body.name);
    const pin = req.body && req.body.pin;

    if (!name || !isFourDigitPin(pin)) {
      return res.status(400).json({ error: "Enter your name and 4-digit PIN." });
    }

    const [draw, people] = await Promise.all([getDraw(), listPeople()]);
    const person = people.find((p) => p.name_key === nameKey(name));
    if (!person || !pinsMatch(person, pin)) {
      return res.status(401).json({ error: "Name or PIN did not match." });
    }

    if (!draw.drawn || !person.match_id) {
      return res.json({ status: "enrolled" });
    }

    const match = people.find((p) => p.id === person.match_id);
    return res.json({
      status: "paired",
      matchName: match ? match.name : "Unknown",
    });
  }).catch((err) => {
    console.error(err);
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/draw", (req, res) => {
  if (!adminOk(req)) {
    return res.status(403).json({
      error: ADMIN_SECRET ? "Wrong host secret." : "Set ADMIN_SECRET to draw names.",
    });
  }

  enqueue(async () => {
    const draw = await getDraw();
    if (draw.drawn) {
      return res.status(409).json({ error: "Names were already drawn." });
    }

    const people = await listPeople();
    if (people.length < 2) {
      return res.status(400).json({ error: "Need at least 2 names before matching." });
    }

    const assignments = cycleAssignments(people.map((p) => p.id));
    for (const assignment of assignments) {
      const { error } = await supabase
        .from("people")
        .update({ match_id: assignment.match_id })
        .eq("id", assignment.id);
      if (error) {
        throw error;
      }
    }

    const { error } = await supabase
      .from("draw")
      .update({ drawn: true, drawn_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) {
      throw error;
    }

    return res.json({ ok: true, count: people.length });
  }).catch((err) => {
    console.error(err);
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/reset", (req, res) => {
  if (!adminOk(req)) {
    return res.status(403).json({
      error: ADMIN_SECRET ? "Wrong host secret." : "Set ADMIN_SECRET to reset.",
    });
  }

  enqueue(async () => {
    const { error: clearMatches } = await supabase.from("people").update({ match_id: null }).not("id", "is", null);
    if (clearMatches) {
      throw clearMatches;
    }
    const { error: deletePeople } = await supabase.from("people").delete().not("id", "is", null);
    if (deletePeople) {
      throw deletePeople;
    }
    const { error } = await supabase.from("draw").update({ drawn: false, drawn_at: null }).eq("id", 1);
    if (error) {
      throw error;
    }
    return res.json({ ok: true });
  }).catch((err) => {
    console.error(err);
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.listen(PORT, () => {
  console.log(`Secret Santa running at http://localhost:${PORT}`);
});
