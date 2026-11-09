import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env file — rely on the real environment
}

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || path.join(ROOT, "data", "app.db"),

  // LLM
  // The SDK also reads an `ant auth login` profile, so a missing env var isn't conclusive.
  hasLlmCredentials: Boolean(
    env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.ANTHROPIC_PROFILE ||
      fs.existsSync(path.join(os.homedir(), ".config", "anthropic")),
  ),
  timeZone: env.TIME_ZONE || "Asia/Bangkok",
  model: env.LLM_MODEL || "claude-opus-5-5",
  extractEffort: env.LLM_EXTRACT_EFFORT || "low",
  // Model for per-post categorization (high volume). Defaults to LLM_MODEL.
  extractModel: env.LLM_EXTRACT_MODEL || env.LLM_MODEL || "claude-opus-5-5",
  vizEffort: env.LLM_VIZ_EFFORT || "medium",
  extractBatchSize: Number(env.EXTRACT_BATCH_SIZE || 10),

  // What to watch for
  topic: env.TOPIC || "flood",
  queries: (env.SEARCH_QUERIES || "น้ำท่วม,น้ำป่า,ขอความช่วยเหลือ น้ำท่วม,Thailand flood")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxPostAgeDays: Number(env.MAX_POST_AGE_DAYS || 7), // ignore older posts at ingest
  sources: (env.SOURCES || "x,mastodon,bluesky").split(",").map((s) => s.trim()),

  // X API (pay-per-use: each post returned costs credit)
  xBearerToken: env.X_BEARER_TOKEN || "",
  xQuery: env.X_QUERY || "", // full X search query; built from SEARCH_QUERIES if empty
  xMaxPostsPerRun: Number(env.X_MAX_POSTS_PER_RUN || 100),
  xDailyBudget: Number(env.X_DAILY_POST_BUDGET || 1000),
  xFirstRunHours: Number(env.X_FIRST_RUN_HOURS || 24),
  xCostPerPost: Number(env.X_COST_PER_POST || 0.005), // USD, for cost estimates only
  mastodonInstance: env.MASTODON_INSTANCE || "https://mastodon.social",
  mastodonTags: (env.MASTODON_TAGS || "thailandflood,น้ำท่วม,ThailandFloods")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  bskyHandle: env.BSKY_HANDLE || "",
  bskyAppPassword: env.BSKY_APP_PASSWORD || "",

  // Scheduler
  liveIngest: bool(env.LIVE_INGEST, false),
  pollMinutes: Number(env.POLL_MINUTES || 10),

  // Personal data: phone numbers in post text are masked in API output unless this is on.
  showPii: bool(env.SHOW_PII, false),
  demoData: bool(env.DEMO_DATA, false),
  ingestToken: env.INGEST_TOKEN || "",
};
