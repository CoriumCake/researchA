import { getJson, stripHtml } from "./util.js";

export const name = "mastodon";

// Public hashtag timelines — no login needed on most instances.
export async function fetch(config) {
  const out = [];
  for (const tag of config.mastodonTags) {
    const url = `${config.mastodonInstance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
    const statuses = await getJson(url);
    for (const s of statuses) {
      out.push({
        id: `mastodon:${s.uri}`,
        source: name,
        url: s.url || s.uri,
        author: s.account?.acct,
        text: stripHtml(s.content),
        created_at: s.created_at,
        lang: s.language,
        query: `#${tag}`,
      });
    }
  }
  return out;
}
