/**
 * "Ask the data" — turns a natural-language question into a constrained visualization
 * spec, validates it, and executes it in JS over the stored reports. The LLM never
 * writes SQL or code; it can only fill in this spec.
 */
import { z } from "zod";
import { config } from "./config.js";
import { CATEGORIES, URGENCY, PROVINCE_NAMES, findProvince, findProvinceInText } from "./taxonomy.js";
import { loadReports } from "./db.js";
import { callJson, describeLlmError } from "./llm.js";

const GROUP_BY = ["province", "category", "urgency", "district", "source", "hour", "day", "need", "poster_type"];
const POSTERS = ["citizen", "government", "media", "business", "unknown"];
const METRICS = ["reports", "incidents", "people_affected"];
const CHARTS = ["bar", "line", "pie", "table", "none"];
const LAYERS = ["markers", "choropleth", "both"];

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "explanation", "chart_type", "group_by", "metric", "top_n", "map_layer", "focus_province", "filters"],
  properties: {
    title: { type: "string" },
    explanation: { type: "string", description: "One or two sentences on what the chart shows and any caveat." },
    chart_type: { type: "string", enum: CHARTS },
    group_by: { type: "string", enum: GROUP_BY },
    metric: { type: "string", enum: METRICS },
    top_n: { type: "integer", description: "Max groups to show; 0 = all." },
    map_layer: { type: "string", enum: LAYERS },
    focus_province: { type: "string", enum: [...PROVINCE_NAMES, ""] },
    filters: {
      type: "object",
      additionalProperties: false,
      required: ["categories", "min_urgency", "provinces", "since_hours", "text_contains", "posted_by"],
      properties: {
        categories: { type: "array", items: { type: "string", enum: CATEGORIES } },
        min_urgency: { type: "string", enum: [...URGENCY, ""] },
        provinces: { type: "array", items: { type: "string", enum: PROVINCE_NAMES } },
        since_hours: { type: "integer", description: "0 = no time limit." },
        text_contains: { type: "string", description: "Keyword matched against post text, needs and summary; \"\" for none." },
        posted_by: { type: "array", items: { type: "string", enum: POSTERS }, description: "Who wrote the post; [] for anyone. Citizens = ordinary people (ประชาชน)." },
      },
    },
  },
};

const Spec = z.object({
  title: z.string(),
  explanation: z.string(),
  chart_type: z.enum(CHARTS),
  group_by: z.enum(GROUP_BY),
  metric: z.enum(METRICS),
  top_n: z.number().int().min(0).max(100),
  map_layer: z.enum(LAYERS),
  focus_province: z.string(),
  filters: z.object({
    categories: z.array(z.enum(CATEGORIES)),
    min_urgency: z.enum([...URGENCY, ""]),
    provinces: z.array(z.string()),
    since_hours: z.number().int().min(0).max(24 * 365),
    text_contains: z.string().max(100),
    posted_by: z.array(z.enum(POSTERS)).default([]),
  }),
});

const systemPrompt = () => `You turn a disaster-response officer's question into a chart specification for a map dashboard.
The data: categorized reports from public posts about a ${config.topic} in Thailand. Each report has
category (${CATEGORIES.join(", ")}), urgency (${URGENCY.join(" < ")}), province, district, source, needs[], people_affected, created_at,
poster_type (${POSTERS.join(", ")}): who wrote the post. The research focuses on posts by ordinary citizens (ประชาชน); use filters.posted_by ["citizen"] when the question is about citizens or the public.
"incidents" counts groups of near-duplicate reports once; prefer it over "reports" when the question is about how many separate situations exist.
group_by "need" splits by items in needs[]. Use chart_type "line" with group_by hour/day for trends, "table" for lists, "none" if only the map matters.
Set focus_province when the question is about one province so the map zooms there. The question may be in Thai or English; write title and explanation in the same language as the question.`;

/** Rule-based fallback so the dashboard still answers simple questions without an API key. */
export function heuristicSpec(q) {
  const s = q.toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  const cats = CATEGORIES.filter((c) => {
    const words = {
      rescue_request: ["rescue", "trapped", "ช่วยเหลือ", "ติดค้าง", "อพยพ"],
      medical: ["medical", "medicine", "ยา", "ป่วย", "บาดเจ็บ"],
      shelter: ["shelter", "ศูนย์พักพิง", "ที่พัก"],
      supplies_needed: ["supplies", "food", "water need", "อาหาร", "น้ำดื่ม", "ของ"],
      damage: ["damage", "เสียหาย"],
      road_closure: ["road", "ถนน", "สะพาน"],
      water_level: ["water level", "ระดับน้ำ"],
      warning: ["warning", "เตือน"],
      volunteer_offer: ["volunteer", "อาสา", "บริจาค"],
    }[c] || [];
    return words.some((w) => s.includes(w));
  });
  const hours = s.match(/(\d+)\s*(h|hr|hour|ชั่วโมง|ชม)/);
  const days = s.match(/(\d+)\s*(d|day|วัน)/);
  const prov = findProvinceInText(q)?.en || "";
  const group_by = has("trend", "over time", "timeline", "แนวโน้ม", "ช่วงเวลา") ? "hour"
    : has("by category", "type", "ประเภท") ? "category"
    : has("need", "ต้องการ") ? "need"
    : has("urgency", "ความเร่งด่วน") ? "urgency"
    : has("who posted", "ผู้โพสต์", "ใครโพสต์") ? "poster_type"
    : prov ? "district" : "province";
  return {
    title: q,
    explanation: "Answered by keyword matching (no LLM key configured), so the result may be rough.",
    chart_type: group_by === "hour" ? "line" : "bar",
    group_by,
    metric: has("people", "คน", "ผู้ประสบภัย") ? "people_affected" : "incidents",
    top_n: 15,
    map_layer: "both",
    focus_province: prov,
    filters: {
      categories: cats,
      min_urgency: has("critical", "วิกฤต") ? "critical" : has("urgent", "เร่งด่วน") ? "high" : "",
      provinces: prov ? [prov] : [],
      since_hours: hours ? +hours[1] : days ? +days[1] * 24 : 0,
      text_contains: "",
      posted_by: has("citizen", "public", "ประชาชน", "ชาวบ้าน") ? ["citizen"] : [],
    },
  };
}

export async function specFromPrompt(question) {
  if (!config.hasLlmCredentials) return { spec: heuristicSpec(question), engine: "keywords" };
  try {
    const { data } = await callJson({
      system: systemPrompt(),
      user: `Current time: ${new Date().toISOString()}\nQuestion: ${question}`,
      schema: SPEC_SCHEMA,
      effort: config.vizEffort,
      maxTokens: 4000,
    });
    return { spec: Spec.parse(data), engine: "llm" };
  } catch (e) {
    return { spec: heuristicSpec(question), engine: "keywords", warning: describeLlmError(e) };
  }
}

// "YYYY-MM-DDTHH:mm" in the responders' time zone, so hour/day buckets match local clocks.
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const localTime = (iso) => fmt.format(new Date(iso)).replace(" ", "T");

/** Execute a validated spec. Returns aggregated rows plus the ids of matching reports. */
export function runSpec(rawSpec) {
  const spec = Spec.parse(rawSpec);
  const f = spec.filters;
  const minU = f.min_urgency ? URGENCY.indexOf(f.min_urgency) : -1;
  const provs = new Set(f.provinces.map((p) => findProvince(p)?.en).filter(Boolean));
  const needle = f.text_contains.trim().toLowerCase();

  const reports = loadReports({ sinceHours: f.since_hours || undefined }).filter(
    (r) =>
      (!f.categories.length || f.categories.includes(r.category)) &&
      URGENCY.indexOf(r.urgency) >= minU &&
      (!provs.size || provs.has(r.province)) &&
      (!f.posted_by.length || f.posted_by.includes(r.poster_type)) &&
      (!needle ||
        [r.text, r.summary, ...r.needs].some((t) => (t || "").toLowerCase().includes(needle))),
  );

  const keysOf = (r) => {
    switch (spec.group_by) {
      case "hour": return [localTime(r.created_at).slice(0, 13) + ":00"];
      case "day": return [localTime(r.created_at).slice(0, 10)];
      case "need": return r.needs.map((n) => n.toLowerCase()); // reports without needs drop out
      default: return [r[spec.group_by] || "(unknown)"];
    }
  };

  const groups = new Map();
  for (const r of reports) {
    for (const k of keysOf(r)) {
      if (!groups.has(k)) groups.set(k, { reports: 0, incidents: new Map() });
      const g = groups.get(k);
      g.reports++;
      // people_affected is summed per incident (max across its reports) to avoid double counting reposts
      const inc = r.incident_id || r.content_hash;
      g.incidents.set(inc, Math.max(g.incidents.get(inc) ?? 0, r.people_affected ?? 0));
    }
  }
  let rows = [...groups].map(([key, g]) => ({
    key,
    value:
      spec.metric === "reports" ? g.reports
      : spec.metric === "incidents" ? g.incidents.size
      : [...g.incidents.values()].reduce((a, b) => a + b, 0),
  }));
  if (spec.group_by === "hour" || spec.group_by === "day") rows.sort((a, b) => a.key.localeCompare(b.key));
  else if (spec.group_by === "urgency") rows.sort((a, b) => URGENCY.indexOf(b.key) - URGENCY.indexOf(a.key));
  else rows.sort((a, b) => b.value - a.value);
  if (spec.top_n && spec.group_by !== "hour" && spec.group_by !== "day") rows = rows.slice(0, spec.top_n);

  return { spec, rows, report_ids: reports.map((r) => r.id), total_reports: reports.length };
}
