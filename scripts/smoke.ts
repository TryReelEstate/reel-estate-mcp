import { ApiClient } from "../src/api-client.js";
import { getConfig } from "../src/config.js";
import { whoami, listProjects, getUsage, projectStats } from "../src/tools.js";
import { close as closeUpstream } from "../src/upstream.js";

/**
 * Smoke test: connects to the backend `/mcp` via OAuth (opens a browser on the
 * first run) and calls a few GET endpoints through it. Read-only by intent, so
 * it's safe against any environment. Run with `npm run smoke`.
 */
async function run() {
  const cfg = getConfig();
  console.log(`Upstream : ${cfg.mcpServerUrl}`);
  console.log(`Read-only: ${cfg.readOnly}\n`);

  const api = new ApiClient();

  try {
    const who = await whoami(api);
    console.log("=== whoami ===");
    console.log(JSON.stringify(who, null, 2));

    if (who.profileStatus === 401) {
      console.error(
        "\n⚠️  401 from the API via /mcp. The OAuth token was rejected — try re-authorizing by " +
          "deleting the token cache (default ~/.reel-estate-mcp/tokens.json) and re-running.",
      );
    } else {
      console.log("\n=== project_stats ===");
      console.log(JSON.stringify(await projectStats(api), null, 2));
      console.log("\n=== list_projects (limit 3) ===");
      console.log(JSON.stringify(await listProjects(api, { limit: 3 }), null, 2));
      console.log("\n=== get_usage ===");
      console.log(JSON.stringify(await getUsage(api), null, 2));
    }
  } finally {
    await closeUpstream().catch(() => {});
  }
  console.log("\n✅ smoke complete");
}

run().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
