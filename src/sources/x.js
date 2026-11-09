/**
 * X (Twitter) official API v2 — recent search (last 7 days).
 * Docs: https://docs.x.com/x-api/posts/search-recent-posts
 *
 * Billing is pay-per-use: every post returned costs credit (about $0.005 per post read at
 * the time of writing). To keep costs predictable this adapter:
 *   - only asks for posts newer than the last one it saw (since_id),
 *   - stops at X_MAX_POSTS_PER_RUN per fetch and X_DAILY_POST_BUDGET per day (UTC).
 */
import { createHash } from "node:crypto";
import { kvGet, kvSet } from "../db.js";
import { UA } from "./util.js";

export const name = "x";

const API = "https://api.x.com/2/tweets/search/recent";

export function buildQuery(config) {
  if (config.xQuery) return config.xQuery;
  const terms = config.queries.map((q) => (/\s/.test(q) ? `"${q}"` : q));
  return `(${terms.join(" OR ")}) -is:retweet`;
}

function usageKey() {
  return `x_reads:${new Date().toISOString().slice(0, 10)}`;
}
export function usageToday() {
  return Number(kvGet(usageKey()) || 0);
}

// The field-list parameter was renamed from tweet.fields to post.fields in newer docs.
// Try the long-standing name first and remember whichever one the API accepts.
let fieldsParam = "tweet.fields";

async function request(params, token) {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set(fieldsParam, "created_at,lang,author_id,geo,conversation_id");
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, "user-agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
    throw new Error(`X rate limit hit; resets ${reset ? new Date(reset).toLocaleTimeString() : "soon"}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && fieldsParam === "tweet.fields" && JSON.stringify(body).includes("tweet.fields")) {
    fieldsParam = "post.fields";
    return request(params, token);
  }
  if (res.status === 401) throw new Error("X bearer token rejected (401)");
  if (res.status === 402 || res.status === 403) {
    throw new Error(`X API access denied (${res.status}) — check credits/app access: ${body.detail || body.title || ""}`);
  }
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.detail || body.title || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/**
 * How many posts match a query per day over the last 7 days. Billed per request
 * (Counts: Recent, ~$0.005), not per post, so it's a cheap way to size a fetch first.
 */
export async function countRecent(query, token) {
  const url = new URL("https://api.x.com/2/tweets/counts/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("granularity", "day");
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, "user-agent": UA }, signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X counts ${res.status}: ${body.detail || body.title || JSON.stringify(body).slice(0, 200)}`);
  return { total: body.meta?.total_tweet_count ?? 0, days: (body.data || []).map((d) => ({ day: d.start.slice(0, 10), n: d.tweet_count })) };
}

export async function fetch_(config) {
  if (!config.xBearerToken) return [];
  const used = usageToday();
  let allowance = Math.min(config.xMaxPostsPerRun, config.xDailyBudget - used);
  if (allowance < 10) {
    throw new Error(`X daily budget reached (${used}/${config.xDailyBudget} posts today)`);
  }

  const query = buildQuery(config);
  // Each query keeps its own "newest post seen" cursor, so one-off backfills with a
  // different query don't disturb the main monitor.
  const cursorKey = `x_since_id:${createHash("sha1").update(query).digest("hex").slice(0, 12)}`;
  const sinceId = config.ignoreCursor ? null : kvGet(cursorKey);
  const out = [];
  let nextToken;
  let newestId = null;
  let read = 0;

  do {
    const page = await request(
      {
        query,
        max_results: String(Math.max(10, Math.min(100, allowance))),
        sort_order: "recency",
        // First run: look back X_FIRST_RUN_HOURS only, instead of the full 7 days.
        since_id: sinceId || undefined,
        start_time: sinceId ? undefined : new Date(Date.now() - config.xFirstRunHours * 3600e3).toISOString(),
        next_token: nextToken,
        // No author_id expansion: X prices User reads at 2x a post read and doesn't say
        // whether expanded authors are billed. author_id comes back on the post anyway.
        expansions: "geo.place_id",
        "place.fields": "full_name,country_code",
      },
      config.xBearerToken,
    );
    const places = new Map((page.includes?.places || []).map((p) => [p.id, p]));
    for (const t of page.data || []) {
      const place = t.geo?.place_id ? places.get(t.geo.place_id) : null;
      out.push({
        id: `x:${t.id}`,
        source: name,
        url: `https://x.com/i/status/${t.id}`,
        author: t.author_id, // numeric account id, no profile lookup
        // A place tag (if the user attached one) helps Claude locate the post.
        text: place ? `${t.text}\n[location tag: ${place.full_name}]` : t.text,
        created_at: t.created_at,
        lang: t.lang,
        query,
      });
    }
    read += page.meta?.result_count || 0;
    newestId ??= page.meta?.newest_id || null;
    allowance -= page.meta?.result_count || 0;
    nextToken = page.meta?.next_token;
  } while (nextToken && allowance >= 10);

  kvSet(usageKey(), used + read);
  if (newestId) kvSet(cursorKey, newestId);
  return out;
}

export { fetch_ as fetch };
