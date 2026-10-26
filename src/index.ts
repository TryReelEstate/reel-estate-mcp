#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { ApiClient } from "./api-client.js";
import { close as closeUpstream, logout as logoutUpstream, login as loginUpstream } from "./upstream.js";
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
  help,
  apiRequest,
  addImageFromFile,
  resolveAddress,
  generateClip,
  getClipStatus,
  editImage,
  renderMovie,
  addTimelineAudio,
  addTimelineOverlay,
  moveTimelineElement,
  reorderTimeline,
  ezReelCatalog,
  listReels,
  ezReelAddPhotos,
  ezReelImportPhotos,
  ezReelCreate,
  ezReelQuote,
  ezReelSubmit,
  ezReelStatus,
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

const server = new McpServer({ name: "reel-estate-backend", version: "0.4.0" });

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
      "Show the upstream MCP URL, read-only flag, the account plan, whether writes are allowed " +
      "(canWrite) with a plain-language writeAccess reason, and the live /users/profile response for " +
      "the OAuth-authenticated user. Good first call to confirm auth and whether create/generate/render " +
      "tools will work (free accounts are read-only over the MCP). If not signed in, it returns a " +
      "'run login' error — use the `login` tool.",
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
  "login",
  {
    title: "Log in",
    description:
      "Authenticate with the backend. If not already logged in, returns an authorization URL to open in " +
      "your browser; approve the sign-in and the token is cached in the background, then retry your action. " +
      "(Browser-based login can't be popped reliably from here, so you click the link.)",
    inputSchema: {},
  },
  async () => {
    try {
      const { completion, ...result } = await loginUpstream();
      void completion; // finishes in the background once the user approves
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "logout",
  {
    title: "Log out",
    description:
      "Clear the cached OAuth session (and best-effort revoke it server-side) so the next tool call " +
      "re-authenticates via the browser. Use to switch accounts or reset a broken auth state.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await logoutUpstream());
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
  "help",
  {
    title: "How to use this server (start-to-finish walkthrough)",
    description:
      "Guided, numbered walkthrough of the whole pipeline — sign in → create a project → add photos → " +
      "edit → animate clips → add music/voiceover/overlays → arrange → render — with example args and " +
      "the gotchas (async polling, paid gating). Call this first if you're not sure where to start.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(help());
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
      addToTimeline: z
        .boolean()
        .optional()
        .describe("Also append a video timeline element so the image is in the render. Default true."),
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
  "resolve_address",
  {
    title: "Geocode a free-text address",
    description:
      "Resolve a free-text address into ranked candidates (formatted, placeId, location, components). " +
      "Use before creating a project for a real listing — pass the chosen candidate as the project " +
      "`address` so listing facts (price/beds/baths) auto-populate. Prefer candidates with isStreetLevel=true.",
    inputSchema: {
      query: z.string().min(3),
      limit: z.number().int().min(1).max(10).optional(),
    },
  },
  async (args) => {
    try {
      return ok(await resolveAddress(api, args));
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
      "poll get_clip_status. imageUrl is auto-resolved from the project if omitted. Costs credits. " +
      "For a whole listing video, ez_reel_create is usually the better tool.",
    inputSchema: {
      projectId: z.string(),
      imageId: z.string(),
      motion: z.enum([
        "auto", "zoom_in", "zoom_out", "no_motion", "orbit", "orbit_left", "orbit_right", "drone", "custom",
      ]),
      duration: z.number().min(3).max(10).optional().describe("Seconds, 3-10 (default 5)."),
      customMotionPrompt: z.string().max(500).optional().describe("Required when motion='custom'."),
      imageUrl: z.string().url().optional().describe("Auto-resolved from the project if omitted."),
      aspectRatio: z.string().optional().describe("Default 16:9."),
      resolution: z
        .string()
        .optional()
        .describe("Default 720p. 1080p needs the Agent, Pro or Enterprise plan."),
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
  "ez_reel_catalog",
  {
    title: "EZ Reel templates and songs",
    description:
      "GET /ez-reel/catalog: the templates, songs (tracks), pacing options and effects ez_reel_create " +
      "accepts, as the signed-in plan sees them (effects are locked on free). Call before ez_reel_create " +
      "to choose a templateId and trackId.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await ezReelCatalog(api));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_reels",
  {
    title: "List EZ Reels",
    description: "GET /ez-reel: the user's EZ Reels. Supports paging and an address search.",
    inputSchema: {
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      search: z.string().max(200).optional(),
    },
  },
  async (args) => {
    try {
      return ok(await listReels(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_add_photos",
  {
    title: "Upload photos to EZ Reel",
    description:
      "Upload 10 to 20 LOCAL photo files (JPEG, PNG or WebP, under 16MB each) into the EZ Reel library, " +
      "in running order, and return their assetIds for ez_reel_create. Uses a presigned upload (no " +
      "storage creds). A file that fails is listed in `failed` without stopping the rest; a photo " +
      "already in the library is reused (deduped) at no upload cost.",
    inputSchema: {
      paths: z.array(z.string()).min(1).max(20).describe("Absolute paths to local image files, in order."),
    },
  },
  async (args) => {
    try {
      return ok(await ezReelAddPhotos(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_import_photos",
  {
    title: "Bring project photos into EZ Reel",
    description:
      "Import a project's photos into the EZ Reel library (all of them, or the imageIds given; at most " +
      "20) and return their assetIds for ez_reel_create. For photos already in a Studio project; for " +
      "local files use ez_reel_add_photos. Each photo's active edited version (staging, twilight) is " +
      "the one imported. No upload, no charge.",
    inputSchema: {
      projectId: z.string(),
      imageIds: z.array(z.string()).max(20).optional().describe("Defaults to every photo in the project."),
    },
  },
  async (args) => {
    try {
      return ok(await ezReelImportPhotos(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_create",
  {
    title: "Create an EZ Reel",
    description:
      "Create a listing reel from 10 to 20 EZ Reel photos (assetIds, in running order) on one template " +
      "and song, as one output per aspect. Motion, timing and cuts are chosen automatically. Nothing is " +
      "charged: call ez_reel_quote next, show the user the cost, then ez_reel_submit.",
    inputSchema: {
      assetIds: z.array(z.string()).min(10).max(20).describe("From ez_reel_add_photos or ez_reel_import_photos, in order."),
      templateId: z.string().describe("From ez_reel_catalog."),
      trackId: z.string().optional().describe("Song id from ez_reel_catalog."),
      pacing: z
        .enum(["beats", "song"])
        .optional()
        .describe("beats = cuts land on the beat; song = the reel runs the length of the song."),
      aspects: z
        .array(z.enum(["9:16", "16:9"]))
        .min(1)
        .max(2)
        .optional()
        .describe("One output per aspect. Default ['9:16'] (Reels, Shorts, TikTok)."),
      title: z.string().max(200).optional(),
      listing: z
        .object({
          address: z.string().max(300).optional(),
          price: z.string().max(40).optional(),
          beds: z.string().max(20).optional(),
          baths: z.string().max(20).optional(),
          sqft: z.string().max(20).optional(),
          yearBuilt: z.string().max(10).optional(),
        })
        .optional()
        .describe("Listing facts the templates can show as text."),
    },
  },
  async (args) => {
    try {
      return ok(await ezReelCreate(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_quote",
  {
    title: "Price an EZ Reel",
    description:
      "GET /ez-reel/:id/quote: the credits a render would cost now. Work already done (cached clips) is " +
      "free. Always show this to the user before ez_reel_submit.",
    inputSchema: { reelId: z.string() },
  },
  async (args) => {
    try {
      return ok(await ezReelQuote(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_submit",
  {
    title: "Render an EZ Reel",
    description:
      "Start rendering every output of the reel. SPENDS CREDITS: only call after showing the user " +
      "ez_reel_quote and getting their go-ahead, and pass confirmCost: true. Async; poll ez_reel_status.",
    inputSchema: {
      reelId: z.string(),
      confirmCost: z.literal(true).describe("Set true only after the user has seen and accepted the quote."),
    },
  },
  async (args) => {
    try {
      return ok(await ezReelSubmit(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ez_reel_status",
  {
    title: "EZ Reel render status",
    description:
      "Each output's render state (queued, generating, composing, ready, failed) and progress, with a " +
      "videoUrl once ready. done=true when every output has finished.",
    inputSchema: { reelId: z.string() },
  },
  async (args) => {
    try {
      return ok(await ezReelStatus(api, args));
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
  "add_timeline_audio",
  {
    title: "Add an audio track to the timeline",
    description:
      "Place an EXISTING audio asset (a generated voiceover, a music track, any audio URL) on the " +
      "timeline at a specific point so it's in the render. duration defaults to the full movie length " +
      "(ideal for background music); pass sourceDuration for a fixed clip like a voiceover. Get a " +
      "voiceover url/durationSec from get_project (project.voiceover / voiceovers[]). Blocked in read-only mode.",
    inputSchema: {
      projectId: z.string(),
      url: z.string().url().describe("Public URL to the audio file (mp3)."),
      startTime: z.number().min(0).optional().describe("Seconds from the start of the movie. Default 0."),
      duration: z.number().min(0.5).optional().describe("Seconds. Defaults to movie length, else sourceDuration, else 5."),
      volume: z.number().min(0).max(1).optional().describe("0-1. Default 1."),
      fadeIn: z.number().min(0).optional(),
      fadeOut: z.number().min(0).optional(),
      title: z.string().optional().describe("Display label for the timeline clip."),
      s3Key: z.string().optional(),
      sourceDuration: z.number().min(0).optional().describe("Full length of the source audio, for a fixed-length clip."),
    },
  },
  async (args) => {
    try {
      return ok(await addTimelineAudio(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "add_timeline_overlay",
  {
    title: "Add an image/logo or text overlay to the timeline",
    description:
      "Overlay an EXISTING image/logo OR a text caption on the timeline at a specific point. For an image, " +
      "pass imageId (already in the project — url auto-resolved) or a direct url; for text, pass `text`. " +
      "position is percent-of-canvas (0-100) from the top-left. Blocked in read-only mode.",
    inputSchema: {
      projectId: z.string(),
      imageId: z.string().optional().describe("Project image id to overlay (url auto-resolved)."),
      url: z.string().url().optional().describe("Direct image url (alternative to imageId)."),
      s3Key: z.string().optional(),
      text: z.string().max(200).optional().describe("Text caption — provide instead of an image for a text overlay."),
      fontColor: z.string().optional().describe("Text color, e.g. #FFFFFF. Text overlays only."),
      fontSize: z.number().positive().optional().describe("Text size in px. Text overlays only."),
      startTime: z.number().min(0).optional().describe("Seconds from the start of the movie. Default 0."),
      duration: z.number().min(0.5).optional().describe("Seconds on screen. Default 5."),
      position: z
        .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
        .optional()
        .describe("Percent-of-canvas position from top-left."),
      opacity: z.number().min(0).max(1).optional(),
      size: z.number().min(0).max(1).optional().describe("Image scale factor 0-1. Image overlays only."),
    },
  },
  async (args) => {
    try {
      return ok(await addTimelineOverlay(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "move_timeline_element",
  {
    title: "Retime a timeline element",
    description:
      "Change when a single timeline element starts and/or how long it lasts (any track). Use to nudge a " +
      "floating audio/overlay element to a new point. To resequence all clips, use reorder_timeline. " +
      "Element ids come from get_project (timeline.tracks[].elements[].id). Blocked in read-only mode.",
    inputSchema: {
      projectId: z.string(),
      elementId: z.string(),
      startTime: z.number().min(0).optional().describe("New start, seconds from the movie start."),
      duration: z.number().min(0.5).optional().describe("New duration in seconds."),
    },
  },
  async (args) => {
    try {
      return ok(await moveTimelineElement(api, args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "reorder_timeline",
  {
    title: "Reorder timeline elements",
    description:
      "Rearrange a track's elements (defaults to the video/clip track) into the given order and recompute " +
      "sequential startTimes so they play back-to-back. Pass element ids in the desired order; omitted " +
      "elements keep their relative order and are appended after. Ids come from get_project. Blocked in read-only mode.",
    inputSchema: {
      projectId: z.string(),
      order: z.array(z.string()).min(1).describe("Element ids in the desired playback order."),
      trackId: z.string().optional().describe("Track to reorder. Defaults to the video track."),
      gap: z.number().min(0).optional().describe("Seconds of gap to insert between elements. Default 0."),
    },
  },
  async (args) => {
    try {
      return ok(await reorderTimeline(api, args));
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

// Prompt = the idiomatic MCP "skill": clients surface it as a reusable
// slash-command/template. Reuses the same walkthrough as the `help` tool so the
// two never drift.
server.registerPrompt(
  "getting_started",
  {
    title: "Getting started: create a listing movie",
    description: "Start-to-finish walkthrough from sign-in to a rendered movie.",
  },
  () => {
    const h = help();
    const text = [
      h.overview,
      "",
      h.firstTime,
      "",
      `**${h.ezReel.title}**`,
      ...h.ezReel.steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "**Studio: the manual path**",
      ...h.steps.map((s) => `${s.n}. **${s.title}** — ${s.do}\n   tools: ${s.tools.join(", ")}`),
      "",
      "Notes:",
      ...h.notes.map((n) => `- ${n}`),
    ].join("\n");
    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
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
