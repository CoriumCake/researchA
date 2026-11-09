# Flood Situation Map

Collects public social media posts about a disaster (default: floods in Thailand), uses Claude to turn
each one into a structured report, and shows them on a live map that responders can query
in plain Thai or English. The goal is a situation picture built from what people are
already posting, so they don't have to fill in a form.

```
sources ──► posts (SQLite) ──► Claude extraction ──► reports ──► map + list + "Ask the data"
 X API       dedup by URL        category, urgency,     near-duplicate     filters, province
 Mastodon     and text hash       province, district,    reposts grouped    shading, charts
 Bluesky*                         needs, people,         into incidents
 /api/ingest                      confidence
```

## Quick start

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY for live categorization
npm start                 # http://localhost:3000
```

The app shows only real collected posts. For a demo without any API keys, run
`npm run seed` (or set `DEMO_DATA=true`) to load 30 made-up posts with saved results;
`npm run reset` clears everything. With a key, click **Fetch now** (or set
`LIVE_INGEST=true`) to pull real posts and have Claude categorize them.

CLI: `npm run seed | ingest | extract | reset`.

## What each report contains

| field | example |
|---|---|
| category | rescue_request, medical, shelter, supplies_needed, damage, road_closure, water_level, warning, situation_update, volunteer_offer |
| urgency | low / medium / high / critical |
| province, district, location_text | Chiang Rai, Mae Sai, "บ้านเลขที่ 45 หมู่ 7 ต.เวียงพางคำ" |
| people_affected, needs[] | 3, ["boat", "evacuation of bedridden elder"] |
| summary, confidence, has_contact | one English line, 0–1, true/false |

Extraction runs in batches of 10 using structured JSON output, and every result is
validated. Results are cached by a hash of the post text, so reposts cost nothing extra.

## Ask the data

Questions like *"rescue requests by province in the last 24h"* or *"หาดใหญ่ต้องการอะไรบ้าง"*
go to Claude, which fills in a fixed **spec** (filters, group-by, metric, chart type, map
layer, focus province). The server checks the spec and runs it itself. The LLM never writes
SQL or code. The spec is shown under the chart and can be re-run via `POST /api/spec`.

## Data sources

| source | status |
|---|---|
| **X (official API v2, recent search)** | needs `X_BEARER_TOKEN`; pay-per-use (~$0.005/post), capped by `X_DAILY_POST_BUDGET` |
| Mastodon hashtag timelines | works with no login (very little Thai activity) |
| Bluesky search | needs `BSKY_HANDLE` + an app password |
| **Facebook, Instagram, LINE, TikTok** | not scraped. Use official/research APIs and push posts to `POST /api/ingest` |

Scraping logged-in Facebook or X pages breaks their terms of service and is a legal risk
for a government tool. The ingest endpoint is the place to plug in the X API, the Facebook
Graph API (for pages you manage), a LINE Official Account webhook, or hotline call logs:

```bash
curl -X POST localhost:3000/api/ingest -H 'content-type: application/json' \
  -d '{"posts":[{"id":"123","source":"x_api","url":"https://x.com/...","text":"...","created_at":"2026-11-03T10:00:00Z"}]}'
```

## Safety and data handling

- Every report is labelled **unverified** and links to its source, with a confidence score.
  Treat it as a lead to confirm, not a confirmed incident.
- Markers sit near the province centre (with a small offset), not at the exact address.
  The precise place is in the popup text.
- Phone numbers are masked in the UI unless `SHOW_PII=true`. Summaries never include names
  or numbers.
- Text inside posts is treated as data, and the prompt tells the model to ignore any
  instructions found in it. All post text is HTML-escaped in the UI.

## LLM settings

Default model is `claude-opus-5-5`. Extraction runs at effort `low` and charts at `medium`;
change these with `LLM_MODEL`, `LLM_EXTRACT_EFFORT` and `LLM_VIZ_EFFORT`. Requests turn on
Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a safety decline is
retried on a fallback model. Remove it in `src/llm.js` if you don't want that.

## Project layout

```
src/server.js        Express API + scheduler
src/sources/         one adapter per source → {id, source, url, text, author, created_at, lang}
src/extract.js       Claude extraction prompt + schema
src/viz.js           question → spec → aggregation (plus keyword fallback)
src/db.js            SQLite (node:sqlite), dedup, incident grouping
src/taxonomy.js      categories, urgency, 77 provinces + Thai/English aliases
public/              Leaflet map, Chart.js charts
data/provinces.geojson  province boundaries (from github.com/chingchai/OpenGISData-Thailand, simplified)
fixtures/            demo posts (made up) + saved extractions
```

## Next steps worth considering

- District-level geocoding (amphoe centroids) for more precise markers
- A responder workflow: mark a report as verified, assigned or resolved
- Alerts (LINE Notify replacement / email) when critical reports appear in a watched province
- Official feeds to cross-check against: Royal Irrigation Department water levels, TMD warnings, GISTDA flood extent
