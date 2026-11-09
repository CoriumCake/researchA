import { getJson } from "./util.js";

export const name = "bluesky";

// Bluesky's post search requires a logged-in session (the public endpoint returns 403).
// Set BSKY_HANDLE and BSKY_APP_PASSWORD (an app password, not your main one) to enable.
let session = null;

async function login(config) {
  session = await getJson("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: config.bskyHandle, password: config.bskyAppPassword }),
  });
}

export async function fetch(config) {
  if (!config.bskyHandle || !config.bskyAppPassword) return [];
  if (!session) await login(config);
  const out = [];
  for (const q of config.queries) {
    const url = `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=50&sort=latest`;
    let data;
    try {
      data = await getJson(url, { headers: { authorization: `Bearer ${session.accessJwt}` } });
    } catch (e) {
      if (!/^40[01]/.test(e.message)) throw e;
      await login(config); // token expired
      data = await getJson(url, { headers: { authorization: `Bearer ${session.accessJwt}` } });
    }
    for (const p of data.posts || []) {
      const rkey = p.uri.split("/").pop();
      out.push({
        id: `bluesky:${p.uri}`,
        source: name,
        url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
        author: p.author.handle,
        text: p.record?.text || "",
        created_at: p.record?.createdAt || p.indexedAt,
        lang: p.record?.langs?.[0],
        query: q,
      });
    }
  }
  return out;
}
