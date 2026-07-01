#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { ApiClient } from "./api-client.js";
import { close as closeUpstream } from "./upstream.js";
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
  addImageFromFile,
  generateClip,
  getClipStatus,
  editImage,
  renderMovie,
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

const api = new ApiClient();

const server = new McpServer({ name: "reel-estate-backend", version: "0.3.0" });

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
      "Show the upstream MCP URL, read-only flag, and the live /users/profile response for the " +
      "OAuth-authenticated user. Good first call to confirm the browser login worked. The FIRST call " +
      "may open a browser to authorize.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await whoami(api));
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
  "add_image_from_file",
  {
    title: "Add a photo to a project from a local file",
    description:
      "Upload a LOCAL image file to a project. Reads the file, mints a presigned S3 URL " +
      "(POST /projects/:id/images/upload-url), PUTs the bytes straight to storage (no credentials " +
      "needed), then attaches it (POST /projects/:id/images). This is the credential-less upload path " +
      "the remote MCP can't do. Image aspect ratio must be between 0.5:1 and 2:1. Blocked in read-only mode.",
    inputSchema: {
      projectId: z.string().describe("Target project id."),
      path: z.string().describe("Absolute path to a local image file (jpg/png/webp)."),
      caption: z.string().optional().describe("Optional caption stored with the image."),
      filename: z.string().optional().describe("Override the stored filename (defaults to the file's basename)."),
    },
  },
  async (args) => {
    try {
      return ok(await addImageFromFile(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "generate_clip",
  {
    title: "Generate a video clip from a project image",
    description:
      "Animate one still project image into a video clip (Runway Gen-4). Async — returns a jobId; " +
      "poll get_clip_status. imageUrl is auto-resolved from the project if omitted. Costs credits.",
    inputSchema: {
      projectId: z.string(),
      imageId: z.string(),
      motion: z.enum([
        "auto", "zoom_in", "zoom_out", "no_motion", "orbit", "orbit_left", "orbit_right", "drone", "custom",
      ]),
      duration: z.number().min(3).max(10).optional().describe("Seconds, 3-10 (default 5)."),
      customMotionPrompt: z.string().max(500).optional().describe("Required when motion='custom'."),
      imageUrl: z.string().url().optional().describe("Auto-resolved from the project if omitted."),
      aspectRatio: z.string().optional(),
      resolution: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await generateClip(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_clip_status",
  {
    title: "Check clip generation status",
    description: "Poll a clip-generation job started by generate_clip (GET /clip-generation/clip-status/:jobId).",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => {
    try {
      return ok(await getClipStatus(api, { jobId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Edit a project image (Gemini)",
    description:
      "Create a non-destructive, versioned edit of a project image. editType: staging/destaging, " +
      "twilight(+_interior), upscale, green_grass, bright_day, seasonal (winter/halloween/christmas +_interior), " +
      "advanced replace/remove/add (need advancedParams), or manual (customPrompt). staging needs roomType+style. " +
      "Async — returns a jobId; the new version appears on the image. Costs 1 credit.",
    inputSchema: {
      projectId: z.string(),
      imageId: z.string(),
      editType: z.enum([
        "staging", "destaging", "twilight", "twilight_interior", "replace", "remove", "add",
        "winter", "halloween", "halloween_interior", "christmas", "christmas_interior",
        "manual", "green_grass", "bright_day", "upscale",
      ]),
      roomType: z.string().optional().describe("Required for staging + advanced/interior edits."),
      style: z.string().optional().describe("Required for staging."),
      advancedParams: z
        .object({ target: z.string(), value: z.string().optional() })
        .optional()
        .describe("Required for replace/remove/add."),
      customPrompt: z.string().optional().describe("Required for editType='manual'."),
    },
  },
  async (args) => {
    try {
      return ok(await editImage(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "render_movie",
  {
    title: "Render the final movie for a project",
    description:
      "Assemble the project's timeline into the final video (clips + music + watermark + overlays). Only " +
      "projectId is required; settings fall back to the project. Async — returns a jobId; poll list_movies. " +
      "Costs credits and an export.",
    inputSchema: {
      projectId: z.string(),
      aiGeneratedLabel: z.boolean().optional().describe("Per-render override of the AI-disclosure label."),
      settings: z
        .object({
          resolution: z.enum(["720p", "1080p", "4k"]).optional(),
          aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
          transitions: z.enum(["none", "fade", "slide", "zoom"]).optional(),
          duration: z.number().min(3).max(60).optional(),
        })
        .optional(),
    },
  },
  async (args) => {
    try {
      return ok(await renderMovie(api, args));
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
  const cfg = getConfig();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[reel-estate-mcp] ready over stdio — upstream=${cfg.mcpServerUrl}` +
      (cfg.readOnly ? " (read-only)" : "") +
      ". OAuth login happens on the first tool call.",
  );
}

const shutdown = async () => {
  await closeUpstream().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[reel-estate-mcp] fatal:", err);
  process.exit(1);
});
