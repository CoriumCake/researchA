import express from "express";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { loadReports, savePosts, stats, sourceMetrics } from "./db.js";
import { CATEGORIES, URGENCY, PROVINCES, findProvince, PLACES } from "./taxonomy.js";
const PLACES_BY_ID = new Map(PLACES.map((p) => [p.id, p]));
import { runOnce, seedDemo, lastRun } from "./pipeline.js";
import { specFromPrompt, runSpec, heuristicSpec } from "./viz.js";
import { usageToday, buildQuery } from "./sources/x.js";
import { describe as describeSettings, updateSettings, resetSettings } from "./settings.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Public visitors arrive through a Cloudflare tunnel, which adds Cf-Connecting-Ip.
// They get a read-only view: no settings changes, no fetching (costs X credit), no demo data.
// Requests straight to localhost (no such header) keep full access.
const isPublic = (req) => Boolean(req.get("cf-connecting-ip"));
const PUBLIC_POST_OK = new Set(["/api/ask", "/api/spec", "/api/ingest"]); // ingest has its own token
app.use((req, res, next) => {
  if (isPublic(req) && req.method !== "GET" && req.method !== "HEAD" && !PUBLIC_POST_OK.has(req.path)) {
    return res.status(403).json({ error: "This public view is read-only." });
  }
  next();
});
// Public Ask questions use Claude up to a small hourly cap, then keyword matching (free).
const PUBLIC_ASK_PER_HOUR = Number(process.env.PUBLIC_ASK_PER_HOUR || 30);
let askWindow = { start: Date.now(), n: 0 };
function publicAskAllowed() {
  if (Date.now() - askWindow.start > 3600e3) askWindow = { start: Date.now(), n: 0 };
  return askWindow.n++ < PUBLIC_ASK_PER_HOUR;
}
app.use(express.static(path.join(ROOT, "public")));
app.get("/provinces.geojson", (_req, res) => res.sendFile(path.join(ROOT, "data", "provinces.geojson")));

// Thai mobile/landline numbers, with or without separators.
const PHONE = /(?:\+?66[\s-]?|0)\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}/g;
const maskPii = (t) => (config.showPii ? t : t?.replace(PHONE, "[phone hidden]"));

// Deterministic jitter around the province centroid so markers in one province don't stack.
// Named places get a small spread (~300 m); province-only reports stay within ~1–3 km of
// the province centre so they don't drift into the sea on small provinces like Phuket.
function jitter(id, p, precise) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  const a = ((h >>> 0) % 360) * (Math.PI / 180);
  const f = ((h >>> 9) % 100) / 100;
  const r = precise ? 0.0005 + f * 0.0025 : 0.008 + f * 0.02;
  return [p.lat + Math.sin(a) * r, p.lon + Math.cos(a) * r];
}

app.get("/api/meta", (req, res) => {
  res.json({
    public: isPublic(req),
    topic: config.topic,
    categories: CATEGORIES,
    urgency: URGENCY,
    llm: config.hasLlmCredentials ? config.model : null,
    live_ingest: config.liveIngest,
    poll_minutes: config.pollMinutes,
    stats: stats(),
    x: config.xBearerToken ? { posts_read_today: usageToday(), daily_budget: config.xDailyBudget, cost_per_post: config.xCostPerPost } : null,
    last_run: lastRun,
  });
});

app.get("/api/reports", (req, res) => {
  const sinceHours = Number(req.query.since_hours) || undefined;
  const reports = loadReports({ sinceHours }).map((r) => {
    const p = findProvince(r.province);
    return {
      ...r,
      text: maskPii(r.text),
      ...(() => {
        const at = r.place_id ? PLACES_BY_ID.get(r.place_id) : p;
        if (!at) return { lat: null, lon: null, precision: null };
        const [lat, lon] = jitter(r.id, at, Boolean(r.place_id));
        return { lat, lon, precision: r.place_id ? "place" : "province" };
      })(),
      verified: false, // every report comes from an unverified public post
    };
  });
  res.json({ reports });
});

app.post("/api/ask", async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "question is required" });
  const { spec, engine, warning } =
    isPublic(req) && !publicAskAllowed()
      ? { spec: heuristicSpec(question), engine: "keywords", warning: "Too many questions this hour; used keyword matching instead of Claude." }
      : await specFromPrompt(question);
  res.json({ ...runSpec(spec), engine, warning });
});

// Re-run an edited spec without calling the LLM again.
app.post("/api/spec", (req, res) => {
  try {
    res.json(runSpec(req.body));
  } catch (e) {
    res.status(400).json({ error: "invalid spec", details: e.issues ?? e.message });
  }
});

// Relevance rate per source and per search query, with estimated X cost per useful post.
app.get("/api/metrics", (req, res) => {
  const m = sourceMetrics({ sinceHours: Number(req.query.since_hours) || undefined });
  const addCost = (r) => {
    if (r.source !== "x") return r;
    const cost = r.posts * config.xCostPerPost;
    return { ...r, est_cost: cost, cost_per_relevant: r.relevant ? cost / r.relevant : null };
  };
  res.json({
    by_source: m.by_source.map(addCost),
    by_query: m.by_query.map(addCost),
    current_x_query: buildQuery(config),
  });
});

// "What to monitor" settings (search terms, sources, limits). Secrets stay in .env.
app.get("/api/settings", (_req, res) => res.json(describeSettings()));
app.put("/api/settings", (req, res) => {
  try {
    res.json(updateSettings(req.body || {}));
  } catch (e) {
    const details = e.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    res.status(400).json({ error: details || e.message });
  }
});
app.post("/api/settings/reset", (_req, res) => res.json(resetSettings()));

app.post("/api/refresh", async (_req, res) => {
  res.json(await runOnce());
});

app.post("/api/demo", (_req, res) => res.json(seedDemo()));

/**
 * Push posts from sources that need their own API credentials (X API, Facebook Graph
 * API for pages you manage, a LINE Official Account webhook relay, 1669 call logs, ...).
 * Body: { posts: [{ id, source, url?, author?, text, created_at?, lang? }] }
 */
app.post("/api/ingest", (req, res) => {
  if (config.ingestToken && req.get("authorization") !== `Bearer ${config.ingestToken}`) {
    return res.status(401).json({ error: "bad token" });
  }
  const posts = (req.body?.posts || [])
    .filter((p) => p && typeof p.text === "string" && p.id)
    .map((p) => ({ ...p, id: `${p.source || "webhook"}:${p.id}`, source: p.source || "webhook" }));
  res.json({ added: savePosts(posts), note: "new posts are categorized on the next refresh" });
});

// Listen on localhost only: other machines reach the app through the Cloudflare tunnel,
// so nobody on the LAN can skip the read-only check by leaving out the header.
app.listen(config.port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Flood situation map → http://localhost:${config.port}`);
  console.log(
    config.hasLlmCredentials
      ? `LLM: ${config.model}`
      : "LLM: no Anthropic credentials found — posts can't be categorized; ask box uses keyword matching",
  );
  // Demo posts are made up; load them only when explicitly asked (DEMO_DATA=true or `npm run seed`).
  if (config.demoData && stats().posts === 0) console.log("Database is empty — loaded demo data:", seedDemo());
  // Auto-fetch: checked every minute so changes to liveIngest/pollMinutes from the UI apply right away.
  let lastAuto = 0;
  setInterval(() => {
    if (!config.liveIngest || Date.now() - lastAuto < config.pollMinutes * 60e3) return;
    lastAuto = Date.now();
    runOnce()
      .then((r) => console.log("[auto-fetch]", JSON.stringify(r)))
      .catch((e) => console.error("[auto-fetch]", e.message));
  }, 60e3);
});
