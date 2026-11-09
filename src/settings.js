/**
 * Runtime-editable "what to monitor" settings.
 * Defaults come from .env (via config.js); values saved from the UI are stored in the
 * database and applied on top. Secrets (API keys/tokens) are never editable here.
 */
import { z } from "zod";
import { config } from "./config.js";
import { kvGet, kvSet, db } from "./db.js";
import { buildQuery } from "./sources/x.js";

export const SOURCE_NAMES = ["x", "mastodon", "bluesky"];
export const EXTRACT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const X_QUERY_MAX = 512; // X recent-search query length limit

const term = z.string().trim().min(1).max(100);
export const Settings = z.object({
  topic: z.string().trim().min(1).max(60),
  queries: z.array(term).min(1).max(25),
  xQuery: z.string().trim().max(X_QUERY_MAX),
  sources: z.array(z.enum(SOURCE_NAMES)),
  mastodonTags: z.array(term.transform((t) => t.replace(/^#/, ""))).max(10),
  maxPostAgeDays: z.number().int().min(1).max(30),
  xMaxPostsPerRun: z.number().int().min(10).max(500),
  xDailyBudget: z.number().int().min(0).max(100000),
  liveIngest: z.boolean(),
  extractModel: z.enum(EXTRACT_MODELS),
  pollMinutes: z.number().int().min(2).max(1440),
});
const KEYS = Object.keys(Settings.shape);

// Snapshot of the .env values before any overrides are applied.
const DEFAULTS = Object.fromEntries(KEYS.map((k) => [k, structuredClone(config[k])]));

function stored() {
  try {
    return JSON.parse(kvGet("settings") || "{}");
  } catch {
    return {};
  }
}

export function currentSettings() {
  return Object.fromEntries(KEYS.map((k) => [k, config[k]]));
}

/** Apply saved overrides onto the shared config object (call once at startup). */
export function loadSettings() {
  const parsed = Settings.partial().safeParse(stored());
  if (parsed.success) Object.assign(config, parsed.data);
}

export function sourceStatus() {
  return {
    x: config.xBearerToken ? "ready" : "needs X_BEARER_TOKEN in .env",
    mastodon: "ready",
    bluesky: config.bskyHandle && config.bskyAppPassword ? "ready" : "needs BSKY_HANDLE + BSKY_APP_PASSWORD in .env",
  };
}

export function describe() {
  const xq = buildQuery(config);
  return {
    settings: currentSettings(),
    defaults: DEFAULTS,
    sources: sourceStatus(),
    x_query: { effective: xq, length: xq.length, max: X_QUERY_MAX, first_run_hours: config.xFirstRunHours },
  };
}

/** Validate and save a (partial) update. Throws a ZodError or Error on bad input. */
export function updateSettings(patch) {
  const next = Settings.parse({ ...currentSettings(), ...patch });
  const effective = buildQuery(next);
  if (effective.length > X_QUERY_MAX) {
    throw new Error(`X query is ${effective.length} characters; the limit is ${X_QUERY_MAX}. Remove some terms.`);
  }
  const searchChanged =
    JSON.stringify(next.queries) !== JSON.stringify(config.queries) || next.xQuery !== config.xQuery;

  // Save only values that differ from .env, so .env changes still take effect for the rest.
  const overrides = Object.fromEntries(
    KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(DEFAULTS[k])).map((k) => [k, next[k]]),
  );
  kvSet("settings", JSON.stringify(overrides));
  Object.assign(config, next);

  // (X cursors are kept per query, so a new query automatically starts with a
  // X_FIRST_RUN_HOURS look-back and an old query resumes where it left off.)
  return { ...describe(), search_changed: searchChanged };
}

export function resetSettings() {
  db.prepare("DELETE FROM kv WHERE k = 'settings'").run();
  Object.assign(config, structuredClone(DEFAULTS));
  return describe();
}

loadSettings();
