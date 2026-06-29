#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { ClerkSession } from "./clerk-session.js";
import { ApiClient } from "./api-client.js";
import {
  whoami,
  listProjects,
  getProject,
  projectStats,
  listClips,
  listVoices,
  getUsage,
  listMovies,
  listEndpoints,
  apiRequest,
} from "./tools.js";

/**
 * Reel Estate backend MCP server (HTTP edition).
 *
 * Authenticates as a single configured user (MCP_USER) via the Clerk Backend
 * API, then exposes tools that call the app's real HTTP endpoints with that
 * user's bearer token. The generic `api_request` tool can reach any route;
 * the rest are convenience wrappers.
 *
 * Transport is stdio — diagnostics go to stderr only; stdout is MCP frames.
 */

const session = new ClerkSession();
const api = new ApiClient(session);

const server = new McpServer({ name: "reel-estate-backend", version: "0.2.0" });

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description:
      "Show which user the server is authenticated as (Clerk id, configured email/id, API base URL, " +
      "read-only flag) and the live /users/profile response. Good first call to confirm auth works.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await whoami(session, api));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "GET /projects for the authenticated user. Supports paging, sorting, search, and status filter.",
    inputSchema: {
      page: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      status: z.enum(["draft", "processing", "completed", "failed"]).optional(),
      sortBy: z.string().optional().describe("e.g. updatedAt, createdAt, name, lastInteractedAt"),
      sortOrder: z.enum(["asc", "desc"]).optional(),
      search: z.string().optional(),
      starred: z.boolean().optional(),
      folderId: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await listProjects(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_project",
  {
    title: "Get a project",
    description: "GET /projects/:id — full project document for the authenticated user.",
    inputSchema: { id: z.string().describe("Project id.") },
  },
  async ({ id }) => {
    try {
      return ok(await getProject(api, { id }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "project_stats",
  {
    title: "Project stats",
    description: "GET /projects/stats — aggregate project counts/metrics for the authenticated user.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await projectStats(api));
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
      "Clips for the authenticated user. With projectId -> GET /clips/project/:projectId; " +
      "otherwise GET /clips (the clip library) with paging/status.",
    inputSchema: {
      projectId: z.string().optional(),
      page: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
    },
  },
  async (args) => {
    try {
      return ok(await listClips(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_movies",
  {
    title: "List movies",
    description: "Rendered movies for the user. With projectId -> GET /movies/project/:projectId; else GET /movies.",
    inputSchema: { projectId: z.string().optional() },
  },
  async (args) => {
    try {
      return ok(await listMovies(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_voices",
  {
    title: "List voices",
    description: "GET /voices — voiceover voices available to the user (stock + cloned).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await listVoices(api));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage",
    description: "GET /billing/usage — credit and export usage for the authenticated user.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await getUsage(api));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_endpoints",
  {
    title: "List API endpoints",
    description:
      "Return the curated catalog of API endpoints (grouped) so you know what `api_request` can call. " +
      "Not exhaustive — every mounted route is reachable, this covers the main surface.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(listEndpoints());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "api_request",
  {
    title: "Call any API endpoint",
    description:
      "Generic authenticated request to ANY backend route. Path is relative to the API base " +
      "(e.g. '/projects' or 'admin/users'). Use list_endpoints to discover paths. Non-GET methods " +
      "are blocked when MCP_READONLY is set. Returns { status, ok, request, data } including error envelopes.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().describe("Path relative to API base, e.g. /projects/123 or admin/stats"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional().describe("JSON body for non-GET requests."),
    },
  },
  async (args) => {
    try {
      return ok(await apiRequest(api, args as any));
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  // Fail fast with a clear message if required config is missing.
  getConfig();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[reel-estate-mcp] connected over stdio — base=${getConfig().apiBaseUrl} user=${getConfig().user}` +
      (getConfig().readOnly ? " (read-only)" : ""),
  );
}

const shutdown = async () => {
  await session.dispose().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[reel-estate-mcp] fatal:", err);
  process.exit(1);
});
