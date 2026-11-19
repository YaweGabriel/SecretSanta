const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REQUESTS = 120;
const MOCK_DB_DELAY_MS = 50;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function waitForApp(url, child) {
  const timeoutAt = Date.now() + 10_000;
  while (Date.now() < timeoutAt && child.exitCode === null) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("The app did not become ready.");
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

async function main() {
  let activeMockRequests = 0;
  let peakMockRequests = 0;
  let mockRequestCount = 0;
  const mockServer = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/rest/v1/rpc/create_basket") {
      res.writeHead(404).end();
      return;
    }

    activeMockRequests += 1;
    mockRequestCount += 1;
    peakMockRequests = Math.max(peakMockRequests, activeMockRequests);
    try {
      const payload = await readBody(req);
      await delay(MOCK_DB_DELAY_MS);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: crypto.randomUUID(),
        publicCode: payload.p_public_code,
        hostName: payload.p_host_name,
        capacity: payload.p_capacity,
        total: 0,
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: error.message }));
    } finally {
      activeMockRequests -= 1;
    }
  });

  mockServer.listen(0, "127.0.0.1");
  await once(mockServer, "listening");
  const mockPort = mockServer.address().port;
  const appPort = await reservePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      SUPABASE_ANON_KEY: "local-load-test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appOutput = "";
  app.stdout.on("data", (chunk) => { appOutput += chunk.toString(); });
  app.stderr.on("data", (chunk) => { appOutput += chunk.toString(); });

  try {
    await waitForApp(appUrl, app);
    const startedAt = performance.now();
    const results = await Promise.all(Array.from({ length: REQUESTS }, async (_, index) => {
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${appUrl}/api/baskets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostName: `Load host ${index}`, capacity: 10 }),
        });
        const body = await response.json();
        return { status: response.status, body, elapsedMs: performance.now() - requestStartedAt };
      } catch (error) {
        return { status: 0, body: { error: error.message, cause: error.cause?.message }, elapsedMs: performance.now() - requestStartedAt };
      }
    }));
    const totalMs = performance.now() - startedAt;
    const failures = results.filter((result) => result.status !== 201);
    const codes = results.map(({ body }) => body.publicCode);
    const latencies = results.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);

    assert.equal(failures.length, 0, `${failures.length} create requests failed: ${JSON.stringify(failures.slice(0, 3))}`);
    assert.equal(new Set(codes).size, REQUESTS, "The app generated duplicate short invite codes.");
    assert.ok(peakMockRequests > 1, `Supabase requests were serialized (peak concurrency ${peakMockRequests}).`);

    process.stdout.write(JSON.stringify({
      requests: REQUESTS,
      successes: results.length - failures.length,
      failures: failures.length,
      peakConcurrentSupabaseRequests: peakMockRequests,
      mockSupabaseRequestCount: mockRequestCount,
      mockSupabaseLatencyMs: MOCK_DB_DELAY_MS,
      totalElapsedMs: Number(totalMs.toFixed(1)),
      throughputPerSecond: Number((REQUESTS / (totalMs / 1000)).toFixed(1)),
      p50RequestLatencyMs: Number(percentile(latencies, 0.5).toFixed(1)),
      p95RequestLatencyMs: Number(percentile(latencies, 0.95).toFixed(1)),
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.stack || error}\nCause: ${error.cause?.stack || error.cause || "none"}\n${appOutput}\n`);
    process.exitCode = 1;
  } finally {
    app.kill();
    await new Promise((resolve) => {
      if (app.exitCode !== null) return resolve();
      app.once("exit", resolve);
      setTimeout(() => resolve(), 2000).unref();
    });
    await new Promise((resolve) => mockServer.close(() => resolve()));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
