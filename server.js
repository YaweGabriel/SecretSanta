require("dotenv").config();

const path = require("path");
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

async function listPeople() {
  const { data, error } = await supabase
    .from("people")
    .select("id, name, name_key, match_id")
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return data || [];
}

app.get("/api/status", (req, res) => {
  enqueue(async () => {
    const [draw, people] = await Promise.all([getDraw(), listPeople()]);
    return res.json({
      count: people.length,
      max: MAX_PEOPLE,
      drawn: Boolean(draw.drawn),
      names: people.map((p) => p.name),
    });
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/join", (req, res) => {
  enqueue(async () => {
    const name = normalizeName(req.body && req.body.name);

    if (!name) {
      return res.status(400).json({ error: "Enter a name." });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: "Use a shorter name." });
    }

    const { error } = await supabase.from("people").insert({
      name,
      name_key: nameKey(name),
    });
    if (error) {
      const mapped = dbError(error);
      return res.status(mapped.status).json({ error: mapped.error });
    }

    return res.json({ status: "enrolled" });
  }).catch((err) => {
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/lookup", (req, res) => {
  enqueue(async () => {
    const name = normalizeName(req.body && req.body.name);
    if (!name) {
      return res.status(400).json({ error: "Enter your name." });
    }

    const [draw, people] = await Promise.all([getDraw(), listPeople()]);
    const person = people.find((p) => p.name_key === nameKey(name));
    if (!person) {
      return res.status(404).json({ error: "That name is not in the draw." });
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
    const mapped = dbError(err);
    res.status(mapped.status).json({ error: mapped.error });
  });
});

app.post("/api/draw", (req, res) => {
  const secret = (req.body && req.body.secret) || req.get("x-admin-secret") || ADMIN_SECRET;
  enqueue(async () => {
    const { data, error } = await supabase.rpc("perform_draw", { p_secret: secret });
    if (error) {
      const mapped = dbError(error);
      return res.status(mapped.status).json({ error: mapped.error });
    }
    return res.json({ ok: true, count: data });
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
