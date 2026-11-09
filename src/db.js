import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { matchPlace } from "./taxonomy.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,          -- source:native_id
  source       TEXT NOT NULL,             -- google_news | mastodon | bluesky | demo | webhook
  url          TEXT,
  author       TEXT,
  text         TEXT NOT NULL,
  lang         TEXT,
  created_at   TEXT NOT NULL,             -- ISO time the post was published
  fetched_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_url ON posts(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_hash ON posts(content_hash);

-- One extraction per distinct text (cache keyed by content hash, so reposts cost nothing).
CREATE TABLE IF NOT EXISTS extractions (
  content_hash   TEXT PRIMARY KEY,
  relevant       INTEGER NOT NULL,
  category       TEXT,
  urgency        TEXT,
  province       TEXT,
  district       TEXT,
  location_text  TEXT,
  people_affected INTEGER,
  needs          TEXT,                    -- JSON array
  summary        TEXT,
  confidence     REAL,
  has_contact    INTEGER,
  model          TEXT,
  extracted_at   TEXT NOT NULL
);

-- Small key/value store for source cursors (e.g. X since_id) and usage counters.
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

-- Who wrote each relevant post (citizen / government / media / business), see posterType.js.
CREATE TABLE IF NOT EXISTS poster_types (
  content_hash TEXT PRIMARY KEY,
  poster_type  TEXT NOT NULL,
  model        TEXT,
  classified_at TEXT NOT NULL
);

-- Near-duplicate grouping: many reposts of one rescue request become one incident.
CREATE TABLE IF NOT EXISTS incident_members (
  content_hash TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL
);
`);

export const kvGet = (k) => db.prepare("SELECT v FROM kv WHERE k = ?").get(k)?.v ?? null;
export const kvSet = (k, v) => db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(k, String(v));

export function normalizeText(t) {
  return t
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#@]\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function hashText(t) {
  return crypto.createHash("sha256").update(normalizeText(t)).digest("hex").slice(0, 32);
}

// Migration: which search query found each post (for comparing query quality).
if (!db.prepare("PRAGMA table_info(posts)").all().some((c) => c.name === "query")) {
  db.exec("ALTER TABLE posts ADD COLUMN query TEXT");
}

const insertPost = db.prepare(`
  INSERT OR IGNORE INTO posts (id, source, url, author, text, lang, created_at, fetched_at, content_hash, query)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Insert normalized posts; returns the number of new rows. */
export function savePosts(posts) {
  let added = 0;
  const now = new Date().toISOString();
  const oldest = Date.now() - config.maxPostAgeDays * 86400e3;
  for (const p of posts) {
    if (!p.text || p.text.trim().length < 10) continue;
    if (p.created_at && new Date(p.created_at).getTime() < oldest) continue; // stale post
    const r = insertPost.run(
      p.id,
      p.source,
      p.url || null,
      p.author || null,
      p.text.slice(0, 4000),
      p.lang || null,
      p.created_at || now,
      now,
      hashText(p.text),
      p.query || null,
    );
    added += Number(r.changes);
  }
  return added;
}

export function pendingHashes(limit = 500) {
  return db
    .prepare(
      `SELECT p.content_hash AS hash, MIN(p.text) AS text, MIN(p.created_at) AS created_at
       FROM posts p LEFT JOIN extractions e ON e.content_hash = p.content_hash
       WHERE e.content_hash IS NULL
       GROUP BY p.content_hash
       ORDER BY MAX(p.created_at) DESC
       LIMIT ?`,
    )
    .all(limit);
}

const insertExtraction = db.prepare(`
  INSERT OR REPLACE INTO extractions
  (content_hash, relevant, category, urgency, province, district, location_text,
   people_affected, needs, summary, confidence, has_contact, model, extracted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function saveExtraction(hash, x, model) {
  insertExtraction.run(
    hash,
    x.relevant ? 1 : 0,
    x.category || null,
    x.urgency || null,
    x.province || null,
    x.district || null,
    x.location_text || null,
    Number.isInteger(x.people_affected) && x.people_affected >= 0 ? x.people_affected : null,
    JSON.stringify(x.needs || []),
    x.summary || null,
    typeof x.confidence === "number" ? x.confidence : null,
    x.has_contact ? 1 : 0,
    model,
    new Date().toISOString(),
  );
  assignIncident(hash, x);
}

// ---- near-duplicate grouping -------------------------------------------------
function trigrams(s) {
  const set = new Set();
  const t = normalizeText(s).replace(/\s+/g, " ");
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

function assignIncident(hash, x) {
  const me = db.prepare("SELECT text FROM posts WHERE content_hash = ? LIMIT 1").get(hash);
  let incident = hash;
  if (me && x.relevant && x.province) {
    const mine = trigrams(me.text);
    const candidates = db
      .prepare(
        `SELECT e.content_hash AS hash, im.incident_id AS incident, MIN(p.text) AS text,
                e.district, e.location_text
         FROM extractions e
         JOIN incident_members im ON im.content_hash = e.content_hash
         JOIN posts p ON p.content_hash = e.content_hash
         WHERE e.province = ? AND e.category = ? AND e.content_hash <> ?
         GROUP BY e.content_hash`,
      )
      .all(x.province, x.category, hash);
    const myLoc = x.location_text ? trigrams(x.location_text) : null;
    for (const c of candidates) {
      // Same wording (a repost), or same district + nearly the same precise location (a rewrite).
      const sameText = jaccard(mine, trigrams(c.text)) >= 0.55;
      const samePlace =
        myLoc && myLoc.size >= 8 && c.location_text && x.district && c.district === x.district &&
        jaccard(myLoc, trigrams(c.location_text)) >= 0.5;
      if (sameText || samePlace) {
        incident = c.incident;
        break;
      }
    }
  }
  db.prepare("INSERT OR REPLACE INTO incident_members (content_hash, incident_id) VALUES (?, ?)").run(
    hash,
    incident,
  );
}

/** All relevant reports joined with their extraction, newest first. */
export function loadReports({ sinceHours } = {}) {
  const since = sinceHours ? new Date(Date.now() - sinceHours * 3600e3).toISOString() : "0000";
  return db
    .prepare(
      `SELECT p.id, p.source, p.url, p.author, p.text, p.created_at, p.content_hash,
              e.category, e.urgency, e.province, e.district, e.location_text,
              e.people_affected, e.needs, e.summary, e.confidence, e.has_contact,
              im.incident_id, pt.poster_type
       FROM posts p
       JOIN extractions e ON e.content_hash = p.content_hash
       LEFT JOIN incident_members im ON im.content_hash = p.content_hash
       LEFT JOIN poster_types pt ON pt.content_hash = p.content_hash
       WHERE e.relevant = 1 AND p.created_at >= ?
       ORDER BY p.created_at DESC`,
    )
    .all(since)
    .map((r) => {
      const report = { ...r, needs: JSON.parse(r.needs || "[]"), has_contact: !!r.has_contact };
      // Named-place match gives a precise point and a consistent province/district.
      const place = matchPlace(report);
      if (place) {
        report.place = place.name;
        report.place_id = place.id;
        report.llm_district = report.district;
        report.province = place.province;
        report.district = place.district;
      }
      return report;
    });
}

/**
 * Relevance rate per source, and per search query for sources that record one.
 * Only categorized posts count toward the rate; demo posts are excluded.
 */
export function sourceMetrics({ sinceHours } = {}) {
  const since = sinceHours ? new Date(Date.now() - sinceHours * 3600e3).toISOString() : "0000";
  const q = (groupBy) =>
    db
      .prepare(
        `SELECT p.source, ${groupBy === "query" ? "COALESCE(p.query, '(not recorded)')" : "NULL"} AS query,
                COUNT(*) AS posts,
                SUM(e.content_hash IS NOT NULL) AS categorized,
                SUM(COALESCE(e.relevant, 0)) AS relevant,
                SUM(e.urgency IN ('high', 'critical') AND e.relevant = 1) AS urgent,
                MIN(p.fetched_at) AS first_fetch, MAX(p.fetched_at) AS last_fetch
         FROM posts p LEFT JOIN extractions e ON e.content_hash = p.content_hash
         WHERE p.source <> 'demo' AND p.fetched_at >= ?
         GROUP BY p.source${groupBy === "query" ? ", p.query" : ""}
         ORDER BY ${groupBy === "query" ? "last_fetch DESC" : "posts DESC"}`,
      )
      .all(since);
  const withRate = (r) => ({ ...r, rate: r.categorized ? r.relevant / r.categorized : null });
  return { by_source: q("source").map(withRate), by_query: q("query").map(withRate) };
}

export function stats() {
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  return {
    posts: one("SELECT COUNT(*) FROM posts"),
    extracted: one("SELECT COUNT(*) FROM extractions"),
    relevant: one("SELECT COUNT(*) FROM extractions WHERE relevant = 1"),
    pending: one(
      "SELECT COUNT(DISTINCT p.content_hash) FROM posts p LEFT JOIN extractions e ON e.content_hash = p.content_hash WHERE e.content_hash IS NULL",
    ),
    last_fetch: one("SELECT MAX(fetched_at) FROM posts"),
  };
}

export function resetDb() {
  db.exec("DELETE FROM incident_members; DELETE FROM extractions; DELETE FROM posts;");
}
