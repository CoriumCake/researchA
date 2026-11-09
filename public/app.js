import { setOnSaved } from "./settings.js";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const CAT = {
  rescue_request: { icon: "🆘", label: "Rescue request" },
  medical: { icon: "🩺", label: "Medical" },
  shelter: { icon: "🏠", label: "Shelter" },
  supplies_needed: { icon: "📦", label: "Supplies needed" },
  damage: { icon: "🏚️", label: "Damage" },
  road_closure: { icon: "🚧", label: "Road closure" },
  water_level: { icon: "🌊", label: "Water level" },
  warning: { icon: "⚠️", label: "Warning" },
  situation_update: { icon: "ℹ️", label: "Update" },
  volunteer_offer: { icon: "🤝", label: "Help offered" },
};
const URG = ["low", "medium", "high", "critical"];
const EXAMPLES = [
  "rescue requests by province in the last 24h",
  "what do people need most?",
  "critical reports over time",
  "สถานการณ์ที่หาดใหญ่",
  "people affected by province",
];

const state = {
  reports: [],
  activeCats: new Set(),
  highlight: null, // Set of report ids from an "ask" answer, or null
  meta: null,
};

// ---------- map ----------
const map = L.map("map", { zoomControl: true }).setView([13.5, 101], 6);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
// Cluster bubbles take the colour of the most urgent report inside them.
const clusters = L.markerClusterGroup({
  maxClusterRadius: 40,
  showCoverageOnHover: false,
  iconCreateFunction: (c) => {
    const top = Math.max(...c.getAllChildMarkers().map((m) => URG.indexOf(m.options.urgency)));
    return L.divIcon({
      className: "",
      html: `<div class="mk cl" style="background:${css(`--u-${URG[top]}`)}">${c.getChildCount()}</div>`,
      iconSize: [32, 32],
    });
  },
});
let provinceLayer = null;
let provinces = null;

// Deep link: /#focus=Phuket&since=0  (since = hours: 6, 24, 72, 168, or 0 for all)
const linkParams = new URLSearchParams(location.hash.slice(1));
if (linkParams.has("since")) $("#f-since").value = linkParams.get("since");
if (linkParams.has("by")) $("#f-by").value = linkParams.get("by");

fetch("/provinces.geojson").then((r) => r.json()).then((g) => {
  provinces = g;
  render();
  const focus = g.features.find((f) => f.properties.en.toLowerCase() === (linkParams.get("focus") || "").toLowerCase());
  if (focus) {
    state.focus = focus.properties.en;
    map.fitBounds(L.geoJSON(focus).getBounds(), { maxZoom: 12 });
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("aria-pressed", "true");
    chip.textContent = `📍 ${focus.properties.en} ${focus.properties.th} only ✕`;
    chip.title = "Show all provinces";
    chip.addEventListener("click", () => {
      state.focus = null;
      chip.remove();
      history.replaceState(null, "", location.pathname);
      render();
    });
    $("#filters").prepend(chip);
    render();
  }
  // Deep link: &at=lat,lon,zoom opens the map at that spot (e.g. at=7.8935,98.3035,16 for Soi Na Nai).
  const at = (linkParams.get("at") || "").split(",").map(Number);
  if (at.length === 3 && at.every(Number.isFinite)) map.setView([at[0], at[1]], at[2]);
});

function markerFor(r, dupCount) {
  const color = css(`--u-${r.urgency}`);
  const icon = L.divIcon({
    className: "",
    html: `<div class="mk${dupCount > 1 ? " dup" : ""}${r.precision === "province" ? " approx" : ""}" data-n="${dupCount}" style="background:${color};position:relative">${CAT[r.category]?.icon || "•"}</div>`,
    iconSize: [26, 26],
  });
  const m = L.marker([r.lat, r.lon], { icon, title: CAT[r.category]?.label, urgency: r.urgency });
  m.bindPopup(() => popupHtml(r, dupCount));
  return m;
}

function popupHtml(r, dupCount) {
  const link = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">open source</a>` : "demo post";
  return `
    <b>${CAT[r.category]?.icon} ${esc(CAT[r.category]?.label)}</b> · <span class="badge" style="color:${css(`--u-${r.urgency}`)}">${esc(r.urgency)}</span><br>
    ${esc(r.summary)}
    <div class="orig">${esc(r.text)}</div>
    <div>📍 ${r.place ? `<b>${esc(r.place)}</b>, ` : ""}${esc([r.district, r.province].filter(Boolean).join(", "))}
      <span class="muted" style="font-size:12px">(${r.precision === "place" ? "named place, ~300 m" : "province only, approximate"})</span></div>
    ${r.location_text ? `<div class="muted" style="font-size:12px">Post says: ${esc(r.location_text)}</div>` : ""}
    ${r.needs.length ? `<div>Needs: ${esc(r.needs.join(", "))}</div>` : ""}
    ${r.people_affected > 0 ? `<div>People affected: ~${r.people_affected}</div>` : ""}
    <div class="muted" style="font-size:12px;margin-top:4px">
      ${esc(r.source)}${r.poster_type ? ` · posted by ${esc(BY_LABEL[r.poster_type] || r.poster_type)}` : ""} · ${new Date(r.created_at).toLocaleString()} · ${link}<br>
      Model confidence ${Math.round((r.confidence ?? 0) * 100)}% · <b>unverified</b>
      ${dupCount > 1 ? ` · ${dupCount} similar posts grouped` : ""}
      ${r.has_contact ? " · contact details in original post" : ""}
    </div>`;
}

// ---------- filtering ----------
function filtered() {
  const since = Number($("#f-since").value);
  const minU = $("#f-urgency").value ? URG.indexOf($("#f-urgency").value) : -1;
  const cutoff = since ? Date.now() - since * 3600e3 : 0;
  return state.reports.filter(
    (r) =>
      new Date(r.created_at).getTime() >= cutoff &&
      URG.indexOf(r.urgency) >= minU &&
      (!state.activeCats.size || state.activeCats.has(r.category)) &&
      (!state.highlight || state.highlight.has(r.id)) &&
      (!state.focus || r.province === state.focus) &&
      byOk(r),
  );
}

const BY_LABEL = { citizen: "citizen", government: "government agency", media: "news / media", business: "business", unknown: "unknown poster" };
function byOk(r) {
  const by = $("#f-by").value;
  if (!by) return true;
  if (by === "citizen") return r.poster_type === "citizen";
  return r.poster_type === "government" || r.poster_type === "media";
}

/** Collapse near-duplicate reports into one entry per incident (most urgent/newest kept). */
function incidents(reports) {
  const byInc = new Map();
  for (const r of reports) {
    const k = r.incident_id || r.content_hash;
    const cur = byInc.get(k);
    if (!cur) byInc.set(k, { r, n: 1 });
    else {
      cur.n++;
      if (URG.indexOf(r.urgency) > URG.indexOf(cur.r.urgency)) cur.r = r;
    }
  }
  return [...byInc.values()];
}

// ---------- render ----------
function render() {
  const rows = filtered();
  const incs = incidents(rows);
  const layer = $("#f-layer").value;

  clusters.clearLayers();
  if (layer !== "choropleth") {
    clusters.addLayers(incs.filter(({ r }) => r.lat != null).map(({ r, n }) => markerFor(r, n)));
    if (!map.hasLayer(clusters)) map.addLayer(clusters);
  } else map.removeLayer(clusters);

  renderChoropleth(incs, layer !== "markers");
  renderKpis(rows, incs);
  renderList(incs);
  renderLegend();
}

function renderChoropleth(incs, show) {
  if (provinceLayer) map.removeLayer(provinceLayer);
  if (!show || !provinces) return;
  const counts = {};
  for (const { r } of incs) if (r.province) counts[r.province] = (counts[r.province] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  const step = (n) => (n ? Math.min(5, 1 + Math.floor((n / max) * 4.999)) : 0);
  provinceLayer = L.geoJSON(provinces, {
    style: (f) => {
      const n = counts[f.properties.en] || 0;
      return {
        weight: 0.6,
        color: css("--border"),
        fillColor: css(`--seq-${step(n)}`),
        fillOpacity: n ? 0.6 : 0.15,
      };
    },
    onEachFeature: (f, l) => {
      const n = counts[f.properties.en] || 0;
      l.bindTooltip(`<b>${esc(f.properties.en)}</b> ${esc(f.properties.th)}<br>${n} incident${n === 1 ? "" : "s"}`, { sticky: true });
      l.on("click", () => askQuestion(`situation in ${f.properties.en}`));
    },
  }).addTo(map);
  provinceLayer.bringToBack();
}

function renderKpis(rows, incs) {
  const crit = incs.filter(({ r }) => r.urgency === "critical").length;
  const rescue = incs.filter(({ r }) => r.category === "rescue_request" || r.category === "medical").length;
  const provs = new Set(incs.map(({ r }) => r.province).filter(Boolean)).size;
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  $("#kpis").innerHTML =
    kpi(incs.length, `incidents (${rows.length} posts)`) +
    kpi(crit, "critical") +
    kpi(rescue, "rescue / medical") +
    kpi(provs, "provinces");
}

function renderList(incs) {
  const sorted = [...incs].sort(
    (a, b) => URG.indexOf(b.r.urgency) - URG.indexOf(a.r.urgency) || b.r.created_at.localeCompare(a.r.created_at),
  );
  $("#list-count").textContent = `(${incs.length})`;
  $("#list").innerHTML = sorted
    .slice(0, 60)
    .map(
      ({ r, n }, i) => `
      <li data-i="${i}" style="--u:${css(`--u-${r.urgency}`)}">
        <div class="row-meta">
          <span class="badge" style="color:${css(`--u-${r.urgency}`)}">${esc(r.urgency)}</span>
          <span>${CAT[r.category]?.icon} ${esc(CAT[r.category]?.label)}</span>
          <span>${esc(r.place || r.district || "")}${(r.place || r.district) && r.province ? " · " : ""}${esc(r.province || (r.place || r.district ? "" : "location unknown"))}</span>
          <span>${timeAgo(r.created_at)}</span>
          ${n > 1 ? `<span>${n} posts</span>` : ""}
        </div>
        <div>${esc(r.summary)}</div>
        ${r.needs.length ? `<div class="needs">Needs: ${esc(r.needs.join(", "))}</div>` : ""}
      </li>`,
    )
    .join("");
  $("#list").querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => {
      const { r, n } = sorted[+li.dataset.i];
      if (r.lat == null) return;
      map.setView([r.lat, r.lon], 11);
      L.popup().setLatLng([r.lat, r.lon]).setContent(popupHtml(r, n)).openOn(map);
    }),
  );
}

function renderLegend() {
  const u = URG.slice()
    .reverse()
    .map((x) => `<span><i class="sw" style="background:${css(`--u-${x}`)}"></i>${x}</span>`)
    .join("");
  const s = [1, 2, 3, 4, 5].map((i) => `<i class="sq" style="background:${css(`--seq-${i}`)}"></i>`).join("");
  $("#legend").innerHTML = `<b>Urgency</b><div class="row">${u}</div>
    <div style="margin-top:6px"><b>Incidents per province</b></div><div class="row" style="gap:0">${s}</div>
    <div class="row" style="align-items:center"><span><i class="sw" style="background:${css("--u-medium")}"></i>named place</span><span><i class="sw approx-sw" style="background:${css("--u-medium")}"></i>province only</span></div>
    <div class="muted" style="margin-top:4px">Solid markers sit at a place the post names (e.g. Patong, Bang Yai canal); dashed ones only name the province.</div>`;
}

function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60e3);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

// ---------- ask the data ----------
let chart = null;
async function askQuestion(q) {
  $("#q").value = q;
  const btn = $("#ask button[type=submit]");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    showAnswer(data);
  } catch (e) {
    $("#answer").hidden = false;
    $("#a-title").textContent = "Couldn't answer that";
    $("#a-expl").textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Show";
  }
}

function showAnswer({ spec, rows, report_ids, total_reports, engine, warning }) {
  $("#answer").hidden = false;
  $("#a-title").textContent = spec.title;
  const total = state.reports.length;
  $("#a-expl").innerHTML =
    (total_reports === 0
      ? `<div class="warn">No collected posts match this yet (${total} relevant posts in the database in total). ` +
        `The map is left unfiltered. Try <b>Fetch now</b>, a wider time range, or new search terms in ⚙ Monitoring settings.</div>`
      : "") +
    `${esc(spec.explanation)} <span class="muted">(${total_reports} matching posts · ${engine === "llm" ? "Claude" : "keyword"} parser)</span>` +
    (warning ? `<div class="warn">LLM unavailable: ${esc(warning)}</div>` : "");

  const metricLabel = { reports: "Posts", incidents: "Incidents", people_affected: "People affected" }[spec.metric];
  $("#a-table").innerHTML =
    `<tr><th>${esc(spec.group_by)}</th><th>${metricLabel}</th></tr>` +
    rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${r.value}</td></tr>`).join("");
  $("#a-spec").textContent = JSON.stringify(spec, null, 2);

  if (chart) chart.destroy();
  const box = $(".chart-box");
  box.hidden = spec.chart_type === "none" || spec.chart_type === "table" || !rows.length;
  if (!box.hidden) {
    const line = spec.chart_type === "line";
    const ink = css("--text-2");
    const grid = css("--border");
    chart = new Chart($("#chart"), {
      type: line ? "line" : "bar",
      data: {
        labels: rows.map((r) => (spec.group_by === "hour" ? r.key.slice(5).replace("T", " ") : r.key)),
        datasets: [{
          label: metricLabel,
          data: rows.map((r) => r.value),
          backgroundColor: css("--accent"),
          borderColor: css("--accent"),
          borderWidth: line ? 2 : 0,
          borderRadius: 4,
          pointRadius: line ? 4 : 0,
          maxBarThickness: 22,
        }],
      },
      options: {
        indexAxis: line ? "x" : "y", // horizontal bars keep Thai/long labels readable
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: ink, precision: 0 }, grid: { color: grid } },
          y: { ticks: { color: ink, precision: 0 }, grid: { display: line, color: grid } },
        },
      },
    });
  }

  // Apply to the map: show only matching reports, map layer, zoom to focus province.
  // With zero matches, don't blank the whole map — leave it unfiltered.
  state.highlight = total_reports ? new Set(report_ids) : null;
  $("#f-layer").value = spec.map_layer;
  // Keep the toolbar filters at least as wide as the answer's, so map/list/KPIs match the chart.
  const h = spec.filters.since_hours;
  $("#f-since").value = h === 0 ? "0" : String([6, 24, 72, 168].find((o) => o >= h) ?? 0);
  $("#f-urgency").value = spec.filters.min_urgency === "low" ? "" : spec.filters.min_urgency;
  const pb = spec.filters.posted_by || [];
  $("#f-by").value = pb.length === 1 && pb[0] === "citizen" ? "citizen" : pb.length ? $("#f-by").value : "";
  render();
  const p = provinces?.features.find((f) => f.properties.en === spec.focus_province);
  if (p) map.fitBounds(L.geoJSON(p).getBounds(), { maxZoom: 10 });
}

$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (q) askQuestion(q);
});
$("#a-clear").addEventListener("click", () => {
  state.highlight = null;
  $("#answer").hidden = true;
  map.setView([13.5, 101], 6);
  render();
});
$("#examples").innerHTML = EXAMPLES.map((q) => `<button type="button">${esc(q)}</button>`).join("");
$("#examples").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => askQuestion(b.textContent)));

// ---------- filters & data loading ----------
$("#f-cats").innerHTML = Object.entries(CAT)
  .map(([k, v]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="false">${v.icon} ${v.label}</button>`)
  .join("");
$("#f-cats").querySelectorAll(".chip").forEach((b) =>
  b.addEventListener("click", () => {
    const k = b.dataset.k;
    state.activeCats.has(k) ? state.activeCats.delete(k) : state.activeCats.add(k);
    b.setAttribute("aria-pressed", state.activeCats.has(k));
    render();
  }),
);
["#f-since", "#f-urgency", "#f-layer", "#f-by"].forEach((s) => $(s).addEventListener("change", render));

async function load() {
  const [meta, { reports }] = await Promise.all([
    fetch("/api/meta").then((r) => r.json()),
    fetch("/api/reports").then((r) => r.json()),
  ]);
  state.meta = meta;
  state.reports = reports;
  // Public (read-only) view: hide controls that change settings or spend X credit.
  if (meta.public) {
    for (const s of ["#open-settings", "#refresh"]) $(s).hidden = true;
    $("#settings")?.close?.();
  }
  const llm = meta.llm ? `LLM: ${meta.llm}` : "No Anthropic key: posts are not being categorized";
  const last = meta.stats.last_fetch ? ` · last fetch ${timeAgo(meta.stats.last_fetch)}` : "";
  const pend = meta.stats.pending ? ` · ${meta.stats.pending} posts waiting to be categorized` : "";
  const xUse = meta.x ? ` · X: ${meta.x.posts_read_today}/${meta.x.daily_budget} posts today (~$${(meta.x.posts_read_today * (meta.x.cost_per_post ?? 0.005)).toFixed(2)})` : " · X: no token";
  $("#status").textContent = llm + xUse + last + pend +(state.refreshNote ? ` · ${state.refreshNote}` : "");
  render();
  loadQuality();
}

// ---------- source quality ----------
const SOURCE_NAMES = { x: "X", mastodon: "Mastodon", bluesky: "Bluesky", webhook: "Pushed in" };
const pct = (r) => (r == null ? "–" : `${Math.round(r * 100)}%`);
const money = (v) => (v == null ? "–" : `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);
const meter = (rate) =>
  `<span class="meter"><span class="track"><span class="fill" style="width:${Math.round((rate ?? 0) * 100)}%"></span></span><b>${pct(rate)}</b></span>`;

async function loadQuality() {
  const hours = Number($("#f-since").value);
  const m = await fetch(`/api/metrics${hours ? `?since_hours=${hours}` : ""}`).then((r) => r.json());
  $("#q-window").textContent = hours ? `· last ${hours} h` : "· all time";

  $("#q-sources").innerHTML = m.by_source.length
    ? `<tr><th>Source</th><th class="num">Posts</th><th class="num">Relevant</th><th>Relevance</th><th class="num" title="Estimated X cost per relevant post">$/useful</th></tr>` +
      m.by_source
        .map(
          (r) => `<tr>
            <td>${esc(SOURCE_NAMES[r.source] || r.source)}</td>
            <td class="num">${r.posts}${r.categorized < r.posts ? ` <span class="muted" title="waiting to be categorized">(${r.posts - r.categorized} pending)</span>` : ""}</td>
            <td class="num">${r.relevant}</td>
            <td>${meter(r.rate)}</td>
            <td class="num">${r.source === "x" ? money(r.cost_per_relevant) : "free"}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td class="muted">No posts collected from real sources in this time window.</td></tr>`;

  const xq = m.by_query.filter((r) => r.source === "x");
  $("#q-queries").innerHTML = xq.length
    ? xq
        .map(
          (r) => `<li class="${r.query === m.current_x_query ? "current" : ""}">
            ${r.query === m.current_x_query ? '<span class="tag">current</span>' : ""}
            <code>${esc(r.query)}</code>
            <div class="qmeta">
              ${meter(r.rate)}
              <span>${r.relevant}/${r.categorized} relevant</span>
              <span>≈ ${money(r.est_cost)} spent · ${money(r.cost_per_relevant)}/useful</span>
              ${r.categorized < 30 ? '<span class="muted" title="Rates from fewer than 30 posts are unreliable">small sample</span>' : ""}
            </div>
          </li>`,
        )
        .join("")
    : `<li class="muted">No X posts yet.</li>`;
}
$("#f-since").addEventListener("change", loadQuality);

$("#refresh").addEventListener("click", async () => {
  const b = $("#refresh");
  b.disabled = true;
  b.textContent = "Fetching…";
  try {
    const r = await fetch("/api/refresh", { method: "POST" }).then((r) => r.json());
    const fetched = Object.entries(r.fetched || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    state.refreshNote = `${r.added ?? 0} new (${fetched})` + (r.extraction?.error ? ` · ${r.extraction.error}` : "");
  } finally {
    b.disabled = false;
    b.textContent = "Fetch now";
    load();
  }
});

setOnSaved(() => load());
load();
setInterval(load, 60e3);
