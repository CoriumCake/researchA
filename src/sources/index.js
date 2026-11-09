/**
 * Source adapters. Each exports `name` and `fetch(config) -> Promise<Post[]>` where
 *   Post = { id, source, url, text, author?, created_at (ISO), lang? }
 *
 * Only sources that allow automated access are included. Facebook, X, LINE and
 * TikTok need their official APIs (and terms) — push those posts in through
 * POST /api/ingest instead of scraping logged-in pages.
 */
import * as mastodon from "./mastodon.js";
import * as bluesky from "./bluesky.js";
import * as x from "./x.js";

// Social media only — this project studies what people post, not news coverage.
export const SOURCES = [x, mastodon, bluesky];

export async function fetchAll(config) {
  const active = SOURCES.filter((s) => config.sources.includes(s.name));
  const results = await Promise.allSettled(active.map((s) => s.fetch(config)));
  const posts = [];
  const report = {};
  results.forEach((r, i) => {
    const name = active[i].name;
    if (r.status === "fulfilled") {
      posts.push(...r.value);
      report[name] = r.value.length;
    } else {
      report[name] = `error: ${r.reason?.message || r.reason}`;
    }
  });
  return { posts, report };
}
