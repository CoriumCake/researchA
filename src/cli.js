import { config } from "./config.js";
import "./settings.js"; // apply settings saved from the UI
import { savePosts, resetDb, stats } from "./db.js";
import { fetchAll } from "./sources/index.js";
import { extractPending } from "./extract.js";
import { seedDemo } from "./pipeline.js";

const cmd = process.argv[2];

switch (cmd) {
  case "seed":
    console.log("demo data:", seedDemo());
    break;
  case "ingest": {
    const { posts, report } = await fetchAll(config);
    console.log("fetched:", report, "new:", savePosts(posts));
    break;
  }
  case "extract":
    console.log(
      await extractPending({ onProgress: (p) => console.log(`  ${p.done}/${p.total} done, ${p.failed} failed`) }),
    );
    break;
  case "count":
  case "backfill": {
    // npm run backfill -- "<X query>" [hours=167] [max=500]
    const { countRecent, fetch: fetchX } = await import("./sources/x.js");
    const query = process.argv[3];
    if (!query) {
      console.log('usage: node src/cli.js count|backfill "<X query>" [hours] [maxPosts]');
      break;
    }
    const counts = await countRecent(query, config.xBearerToken);
    console.log(`matching posts in last 7 days: ${counts.total} (≈ $${(counts.total * config.xCostPerPost).toFixed(2)})`);
    console.log(counts.days.map((d) => `${d.day}: ${d.n}`).join("  "));
    if (cmd === "count") break;
    const hours = Math.min(Number(process.argv[4] || 167), 167.5);
    const max = Number(process.argv[5] || 500);
    const posts = await fetchX({ ...config, xQuery: query, xFirstRunHours: hours, xMaxPostsPerRun: max, ignoreCursor: true });
    console.log(`fetched ${posts.length}, new ${savePosts(posts)}`);
    console.log(await extractPending({ limit: 2000 }));
    break;
  }
  case "reset":
    resetDb();
    console.log("database cleared");
    break;
  default:
    console.log("usage: node src/cli.js seed|ingest|extract|reset");
}
console.log("stats:", stats());
