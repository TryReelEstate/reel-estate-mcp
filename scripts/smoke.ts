import { ClerkSession } from "../src/clerk-session.js";
import { ApiClient } from "../src/api-client.js";
import { getConfig } from "../src/config.js";
import { whoami, listProjects, getUsage, projectStats } from "../src/tools.js";

/**
 * Smoke test: authenticates as MCP_USER via Clerk and calls a few GET
 * endpoints. Read-only by intent (never issues writes), so it's safe to run
 * against any environment. Run with `npm run smoke`.
 */
async function run() {
  const cfg = getConfig();
  console.log(`Base URL : ${cfg.apiBaseUrl}`);
  console.log(`User     : ${cfg.user}`);
  console.log(`Read-only: ${cfg.readOnly}\n`);

  const session = new ClerkSession();
  const api = new ApiClient(session);

  try {
    const who = await whoami(session, api);
    console.log("=== whoami ===");
    console.log(JSON.stringify(who, null, 2));

    if (who.profileStatus === 401) {
      console.error(
        "\n⚠️  401 from the API. The Clerk session was minted, but the API rejected the token — " +
          "almost always a Clerk-instance/base-URL mismatch (test keys vs production, or vice versa). " +
          "Match CLERK_SECRET_KEY to API_BASE_URL.",
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
    await session.dispose().catch(() => {});
  }
  console.log("\n✅ smoke complete");
}

run().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
