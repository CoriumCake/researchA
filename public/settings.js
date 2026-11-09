// "What to monitor" settings dialog.
const $ = (s) => document.querySelector(s);
const dlg = $("#settings");
const form = $("#settings-form");
const X_MAX = 512;
const COST_PER_X_POST = 0.005;
let loaded = null;
export let onSaved = () => {};
export const setOnSaved = (fn) => (onSaved = fn);

const SOURCE_LABELS = { x: "X (Twitter)", mastodon: "Mastodon", bluesky: "Bluesky" };

// Same rule as the server: phrases with spaces get quotes, reposts excluded.
function buildXQuery(terms) {
  return `(${terms.map((q) => (/\s/.test(q) ? `"${q}"` : q)).join(" OR ")}) -is:retweet`;
}
const lines = (s) => s.split("\n").map((t) => t.trim()).filter(Boolean);
const list = (s) => s.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);

function msg(text, kind = "") {
  $("#s-msg").textContent = text;
  $("#s-msg").className = `hint ${kind}`;
}

function updatePreview() {
  const custom = $("#xq-custom").checked;
  $("#xq-text").hidden = !custom;
  $("#xq-preview").hidden = custom;
  const q = custom ? form.xQuery.value.trim() : buildXQuery(lines(form.queries.value));
  $("#xq-preview").textContent = q;
  $("#xq-len").textContent = `${q.length}/${X_MAX}`;
  $("#xq-len").classList.toggle("over", q.length > X_MAX);
  const budget = Number(form.xDailyBudget.value) || 0;
  $("#budget-cost").textContent = `≈ $${(budget * COST_PER_X_POST).toFixed(2)}/day max`;
}

function fill({ settings: s, sources, x_query }) {
  form.topic.value = s.topic;
  form.queries.value = s.queries.join("\n");
  $("#xq-custom").checked = Boolean(s.xQuery);
  form.xQuery.value = s.xQuery || x_query.effective;
  form.mastodonTags.value = s.mastodonTags.join(", ");
  for (const k of ["maxPostAgeDays", "xMaxPostsPerRun", "xDailyBudget", "pollMinutes"]) form[k].value = s[k];
  form.liveIngest.checked = s.liveIngest;
  form.extractModel.value = s.extractModel;
  $("#xq-lookback").textContent = x_query.first_run_hours;
  $("#s-sources").innerHTML = Object.entries(SOURCE_LABELS)
    .map(([k, label]) => {
      const status = sources[k];
      const ready = status === "ready";
      return `<label class="inline"><input type="checkbox" name="src" value="${k}" ${s.sources.includes(k) ? "checked" : ""}/>
        ${label}<span class="note">${ready ? "✓ ready" : "— " + status.replace(/[<>&]/g, "")}</span></label>`;
    })
    .join("");
  updatePreview();
}

function collect() {
  return {
    topic: form.topic.value.trim(),
    queries: lines(form.queries.value),
    xQuery: $("#xq-custom").checked ? form.xQuery.value.trim() : "",
    sources: [...form.querySelectorAll("input[name=src]:checked")].map((c) => c.value),
    mastodonTags: list(form.mastodonTags.value),
    maxPostAgeDays: Number(form.maxPostAgeDays.value),
    xMaxPostsPerRun: Number(form.xMaxPostsPerRun.value),
    xDailyBudget: Number(form.xDailyBudget.value),
    pollMinutes: Number(form.pollMinutes.value),
    liveIngest: form.liveIngest.checked,
    extractModel: form.extractModel.value,
  };
}

async function open() {
  msg("");
  try {
    loaded = await fetch("/api/settings").then((r) => r.json());
    fill(loaded);
    dlg.showModal();
  } catch (e) {
    console.error("[settings]", e);
  }
}

async function save(e) {
  e.preventDefault();
  const body = collect();
  if (!body.queries.length) return msg("Add at least one search term.", "err");
  const btn = $("#s-save");
  btn.disabled = true;
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return msg(data.error || "Could not save.", "err");
    loaded = data;
    fill(data);
    msg(
      data.search_changed
        ? "Saved. New search terms apply from the next fetch."
        : "Saved.",
      "ok",
    );
    onSaved(data);
  } catch (err) {
    msg(err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function reset() {
  const data = await fetch("/api/settings/reset", { method: "POST" }).then((r) => r.json());
  loaded = data;
  fill(data);
  msg("Reset to the values in .env.", "ok");
  onSaved(data);
}

$("#open-settings").addEventListener("click", open);
$("#s-close").addEventListener("click", () => dlg.close());
$("#s-cancel").addEventListener("click", () => dlg.close());
$("#s-reset").addEventListener("click", reset);
form.addEventListener("submit", save);
form.addEventListener("input", updatePreview);
$("#xq-custom").addEventListener("change", () => {
  if ($("#xq-custom").checked && !form.xQuery.value.trim()) form.xQuery.value = buildXQuery(lines(form.queries.value));
  updatePreview();
});

// Deep link: /#settings opens the dialog.
if (location.hash === "#settings") open();
