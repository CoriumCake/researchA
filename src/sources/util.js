export const UA = "flood-situation-map/0.1 (+public-safety research)";

export async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${new URL(url).host}`);
  return res.json();
}

export function stripHtml(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
