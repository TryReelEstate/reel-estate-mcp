#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, closeDb } from "./db.js";
import {
  findUser,
  listProjects,
  getProject,
  listClips,
  getUsageSummary,
  dbOverview,
} from "./tools.js";

/**
 * Reel Estate backend MCP server.
 *
 * Exposes READ-ONLY tools over the backend's MongoDB so an assistant can
 * inspect users, projects, clips, and usage for support/debugging. No tool
 * here mutates data.
 *
 * Transport is stdio, so NOTHING may be written to stdout except MCP protocol
 * frames — all diagnostics go to stderr (console.error).
 */

const server = new McpServer({
  name: "reel-estate-backend",
  version: "0.1.0",
});

/** Wrap a tool handler: run it, JSON-serialize the result, surface errors. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

server.registerTool(
  "find_user",
  {
    title: "Find user",
    description:
      "Look up a single user by ObjectId (24-char hex) or email. Returns profile, " +
      "subscription, and account-level usage. The legacy password hash is never returned.",
    inputSchema: {
      user: z.string().describe("User ObjectId hex or email address."),
    },
  },
  async ({ user }) => {
    try {
      return ok(await findUser(await getDb(), { user }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List a user's projects",
    description:
      "List projects belonging to a user (by id or email), newest-interacted first. " +
      "Returns lightweight summaries (counts, status, address) — not full timeline/images.",
    inputSchema: {
      user: z.string().describe("User ObjectId hex or email address."),
      status: z
        .enum(["draft", "processing", "completed", "failed"])
        .optional()
        .describe("Optional project status filter."),
      limit: z.number().int().positive().optional().describe("Max projects to return (default 20)."),
      skip: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)."),
      includeDeleted: z.boolean().optional().describe("Include soft-deleted projects (default false)."),
    },
  },
  async (args) => {
    try {
      return ok(await listProjects(await getDb(), args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_project",
  {
    title: "Get a project",
    description:
      "Fetch one project by id. The heavy `timeline` and `images` arrays are excluded " +
      "by default; opt in with includeTimeline / includeImages.",
    inputSchema: {
      projectId: z.string().describe("Project ObjectId hex."),
      includeTimeline: z.boolean().optional().describe("Include the full editor timeline (large)."),
      includeImages: z.boolean().optional().describe("Include the images array with vision data (large)."),
    },
  },
  async (args) => {
    try {
      return ok(await getProject(await getDb(), args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_clips",
  {
    title: "List clips",
    description:
      "List generated video clips scoped by user and/or project. At least one of " +
      "`user` or `projectId` is required. Returns clip status, motion, provider, and credits.",
    inputSchema: {
      user: z.string().optional().describe("User ObjectId hex or email."),
      projectId: z.string().optional().describe("Project ObjectId hex."),
      status: z
        .enum(["pending", "processing", "completed", "failed"])
        .optional()
        .describe("Optional clip processing-status filter."),
      limit: z.number().int().positive().optional().describe("Max clips to return (default 20)."),
      skip: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)."),
    },
  },
  async (args) => {
    try {
      return ok(await listClips(await getDb(), args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_usage_summary",
  {
    title: "Get usage summary",
    description:
      "Aggregate a user's footprint: account credit/export usage, plan, project counts " +
      "by status, and clip counts by status — a one-call support dashboard.",
    inputSchema: {
      user: z.string().describe("User ObjectId hex or email address."),
    },
  },
  async ({ user }) => {
    try {
      return ok(await getUsageSummary(await getDb(), { user }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "db_overview",
  {
    title: "Database overview",
    description:
      "Estimated document counts for the core collections. Useful as a connectivity/health check.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await dbOverview(await getDb()));
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[reel-estate-mcp] server connected over stdio");
}

const shutdown = async () => {
  await closeDb().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[reel-estate-mcp] fatal:", err);
  process.exit(1);
});
