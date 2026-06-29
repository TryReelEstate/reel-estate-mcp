import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import {
  findUser,
  listProjects,
  getProject,
  listClips,
  getUsageSummary,
  dbOverview,
} from "../src/tools.js";

/**
 * Smoke test: exercises every read-only tool against the configured database.
 * Run with `npm run smoke`. Uses the known staging example user by default;
 * override with `SMOKE_USER=<id-or-email>`.
 */
const USER = process.env.SMOKE_USER ?? "69b0b5cffc721a453860a8e6";

function show(label: string, data: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function run() {
  const db = await getDb();

  show("db_overview", await dbOverview(db));

  const user = await findUser(db, { user: USER });
  show("find_user", user);

  const projects = await listProjects(db, { user: USER, limit: 3 });
  show("list_projects (limit 3)", projects);

  const firstProjectId = projects.projects[0]?._id;
  if (firstProjectId) {
    show("get_project (summary)", await getProject(db, { projectId: firstProjectId }));
  }

  show("list_clips (limit 3)", await listClips(db, { user: USER, limit: 3 }));
  show("get_usage_summary", await getUsageSummary(db, { user: USER }));

  await closeDb();
  console.log("\n✅ smoke test complete");
}

run().catch(async (err) => {
  console.error("❌ smoke test failed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
