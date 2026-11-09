// Who wrote each relevant post: a member of the public, a government agency, a news outlet,
// or a business. The research focuses on citizen posts, so the map can filter by this.
import { db } from "./db.js";
import { callJson } from "./llm.js";
import { config } from "./config.js";

export const POSTER_TYPES = ["citizen", "government", "media", "business", "unknown"];

db.exec(`CREATE TABLE IF NOT EXISTS poster_types (
  content_hash TEXT PRIMARY KEY,
  poster_type  TEXT NOT NULL,
  model        TEXT,
  classified_at TEXT NOT NULL
)`);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "poster_type"],
        properties: { n: { type: "integer" }, poster_type: { type: "string", enum: POSTER_TYPES } },
      },
    },
  },
};

const SYSTEM = `You label who wrote Thai social media posts about a disaster.
- citizen: an ordinary person writing as themselves: what they see, their home, their street, asking for help, sharing photos, complaining, offering help as an individual. Also counts when a person relays an official notice in their own words.
- government: written by or as an official body: municipality (เทศบาล, อบต.), disaster prevention (ปภ.), province, police, military, government radio (สวท.), official announcements (ประกาศ, แจ้งเตือนจาก...).
- media: a news outlet, news page or journalist reporting (headline style, "ข่าว", outlet names, hashtags of news pages).
- business: a hotel, shop, tour or insurance company, or an ad.
- unknown: cannot tell.
Judge from the wording only. Return one label per post number.`;

export async function classifyPosterTypes({ batch = 20 } = {}) {
  const rows = db
    .prepare(
      `SELECT e.content_hash AS hash, MIN(p.text) AS text
       FROM extractions e JOIN posts p ON p.content_hash = e.content_hash
       LEFT JOIN poster_types t ON t.content_hash = e.content_hash
       WHERE e.relevant = 1 AND t.content_hash IS NULL
       GROUP BY e.content_hash`,
    )
    .all();
  const save = db.prepare("INSERT OR REPLACE INTO poster_types VALUES (?, ?, ?, ?)");
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const user = chunk.map((r, j) => `[${j}] ${r.text.slice(0, 800)}`).join("\n\n");
    const { data, model } = await callJson({ system: SYSTEM, user, schema: SCHEMA, effort: "low", maxTokens: 4000, model: config.extractModel });
    for (const r of data.results) {
      const row = chunk[r.n];
      if (row) { save.run(row.hash, r.poster_type, model, new Date().toISOString()); done++; }
    }
  }
  return { done, total: rows.length };
}

export function posterTypeOf(hash) {
  return db.prepare("SELECT poster_type FROM poster_types WHERE content_hash = ?").get(hash)?.poster_type || null;
}
