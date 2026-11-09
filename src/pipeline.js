import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { savePosts, saveExtraction, hashText, db } from "./db.js";
import { fetchAll } from "./sources/index.js";
import { extractPending } from "./extract.js";

let running = false;
export let lastRun = null;

/** Fetch from all sources, then categorize anything new. */
export async function runOnce() {
  if (running) return { skipped: "already running" };
  running = true;
  const started = new Date().toISOString();
  try {
    const { posts, report } = await fetchAll(config);
    const added = savePosts(posts);
    const extraction = await extractPending();
    lastRun = { started, finished: new Date().toISOString(), fetched: report, added, extraction };
    return lastRun;
  } finally {
    running = false;
  }
}

/**
 * Load the demo posts. Timestamps are stored as "minutes ago" so the demo always
 * looks current. Saved extractions are loaded too, so the map works with no API key.
 */
export function seedDemo() {
  const posts = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "demo-posts.json"), "utf8"));
  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "demo-extractions.json"), "utf8"));
  const now = Date.now();
  // Replace earlier demo rows so their timestamps refresh.
  db.exec("DELETE FROM posts WHERE source = 'demo'");
  const added = savePosts(
    posts.map((p) => ({
      id: `demo:${p.id}`,
      source: "demo",
      url: null,
      author: p.author,
      text: p.text,
      lang: p.lang,
      created_at: new Date(now - p.minutes_ago * 60e3).toISOString(),
    })),
  );
  let restored = 0;
  for (const p of posts) {
    const x = saved[p.id];
    if (!x) continue;
    saveExtraction(hashText(p.text), x, "saved-demo");
    restored++;
  }
  return { added, restored };
}
