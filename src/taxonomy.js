import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export const CATEGORIES = [
  "rescue_request", // people trapped / asking to be evacuated
  "medical", // injured, sick, need medicine or a doctor
  "shelter", // evacuation centres, people needing a place to stay
  "supplies_needed", // food, water, boats, sandbags, etc.
  "damage", // houses, farms, infrastructure damaged
  "road_closure", // roads/bridges cut, transport blocked
  "water_level", // river/rain gauge readings, rising/falling water
  "warning", // official or community warnings, forecasts
  "situation_update", // general description of conditions
  "volunteer_offer", // people/groups offering help or donations
];

export const URGENCY = ["low", "medium", "high", "critical"];

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "provinces.geojson"), "utf8"));
export const PROVINCES = geo.features.map((f) => f.properties); // {code, th, en, region, lat, lon}
export const PROVINCE_NAMES = PROVINCES.map((p) => p.en).sort();

const byKey = new Map();
const key = (s) => s.toLowerCase().replace(/[\s.\-]/g, "");
for (const p of PROVINCES) {
  byKey.set(key(p.en), p);
  byKey.set(key(p.th), p);
}
// Common alternate spellings / short forms
const ALIASES = {
  "กทม": "Bangkok", "กรุงเทพ": "Bangkok", "krungthep": "Bangkok",
  "ayutthaya": "Phra Nakhon Si Ayutthaya", "อยุธยา": "Phra Nakhon Si Ayutthaya",
  "korat": "Nakhon Ratchasima", "โคราช": "Nakhon Ratchasima",
  "chainat": "Chainat", "chainath": "Chainat", "chai nat": "Chainat",
  "lopburi": "Lopburi", "lop buri": "Lopburi",
  "buriram": "Buriram", "buri ram": "Buriram",
  "chonburi": "Chonburi", "chon buri": "Chonburi",
  "sisaket": "Sisaket", "si sa ket": "Sisaket",
  "nakhonsithammarat": "Nakhon Si Thammarat", "นครศรีฯ": "Nakhon Si Thammarat",
  "hatyai": "Songkhla", "หาดใหญ่": "Songkhla",
  "maesai": "Chiang Rai", "แม่สาย": "Chiang Rai",
};
for (const [a, en] of Object.entries(ALIASES)) {
  const p = PROVINCES.find((x) => x.en === en);
  if (p) byKey.set(key(a), p);
}

const AMBIGUOUS = new Set(["เลย", "ตาก"]);

/** First province (or alias) mentioned anywhere in free text — Thai has no word spaces. */
export function findProvinceInText(text) {
  const t = key(String(text));
  let best = null;
  for (const [k, p] of byKey) {
    // "เลย" (Loei) and "ตาก" (Tak) are also everyday Thai words; require a จ./จังหวัด prefix.
    const hit = AMBIGUOUS.has(k) ? t.includes("จ" + k) || t.includes("จังหวัด" + k) : t.includes(k);
    if (k.length >= 3 && hit && (!best || k.length > best[0].length)) best = [k, p];
  }
  return best?.[1] || null;
}

/** Map any spelling the LLM or a user gives to the canonical province record, or null. */
export function findProvince(name) {
  if (!name) return null;
  return byKey.get(key(String(name).replace(/^(จังหวัด|จ\.)/, ""))) || null;
}

// ---- named places (more precise than province centres) ----------------------
const placesFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8"));
export const PLACES = placesFile.places;
const PLACE_ALIASES = placesFile.places
  .flatMap((p) => p.aliases.map((a) => ({ alias: a.toLowerCase(), place: p })))
  // Specific landmarks (a junction, a canal) beat areas; then the longest alias wins.
  .sort((a, b) => (a.place.level === "landmark" ? 0 : 1) - (b.place.level === "landmark" ? 0 : 1) || b.alias.length - a.alias.length);

/**
 * Find a known place for a report. Looks in location_text first, then the post text,
 * then the district. A place only counts if the report's province matches it, or the
 * report has no province and either the text names that province or the place name
 * is unambiguous (e.g. ป่าตอง). Returns the place record or null.
 */
export function matchPlace({ location_text, text, district, province }) {
  for (const field of [location_text, text, district]) {
    const hay = (field || "").toLowerCase();
    if (!hay) continue;
    for (const { alias, place } of PLACE_ALIASES) {
      if (!hay.includes(alias)) continue;
      const prov = PROVINCES.find((p) => p.en === place.province);
      const allText = `${text || ""} ${location_text || ""}`.toLowerCase();
      const ok =
        province === place.province ||
        (!province && (place.unique || allText.includes(prov.th) || allText.includes(prov.en.toLowerCase())));
      if (ok) return place;
    }
  }
  return null;
}
