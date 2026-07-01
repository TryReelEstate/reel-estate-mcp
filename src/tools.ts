import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiClient, type HttpMethod } from "./api-client.js";
import { CATALOG } from "./catalog.js";
import { getConfig } from "./config.js";

/**
 * Tool implementations as plain functions over an ApiClient. The MCP layer
 * (index.ts) serializes their return values; the smoke test calls them
 * directly. Convenience tools are thin wrappers over specific endpoints;
 * `apiRequest` is the general escape hatch that can hit any route.
 */

// Plan gating mirror of the backend's core/security/mcp-access.ts, so this
// client can explain write access up front instead of only discovering it via a
// 403 mid-action. Keep the two in sync: free = read-only over the MCP; any other
// plan can write (legacy starter/professional map to paid tiers).
const PLAN_ALIASES: Record<string, string> = { starter: "basic", professional: "pro" };
function isPaidPlan(plan?: string): boolean {
  if (!plan) return false;
  const p = PLAN_ALIASES[plan.toLowerCase()] ?? plan.toLowerCase();
  return p !== "free";
}

export async function whoami(api: ApiClient) {
  const { mcpServerUrl, readOnly } = getConfig();
  const profile = await api.get("/users/profile");
  const user = (profile.data as { data?: { subscription?: { plan?: string } } })?.data;
  const plan = user?.subscription?.plan;
  const paid = isPaidPlan(plan);

  // Two independent gates can block writes: the server-side paid-plan check
  // (free accounts are read-only over the MCP) and this client's own read-only
  // config. Report the effective state and the specific reason.
  const canWrite = !readOnly && paid;
  const writeAccess = readOnly
    ? "This MCP server is running in read-only mode (MCP_READONLY); all writes are disabled locally."
    : paid
      ? `Your plan (${plan}) can create, edit, generate, and render via the MCP.`
      : `Your plan (${plan ?? "free"}) is read-only over the MCP. Creating, editing, generating, or ` +
        "rendering requires a paid plan — upgrade to enable writes (browsing/read tools still work).";

  return {
    mcpServerUrl,
    readOnly,
    authenticated: profile.ok,
    profileStatus: profile.status,
    plan: plan ?? null,
    canWrite,
    writeAccess,
    profile: profile.data,
  };
}

export async function listProjects(
  api: ApiClient,
  args: {
    page?: number;
    limit?: number;
    status?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    search?: string;
    starred?: boolean;
    folderId?: string;
  },
) {
  return summarize(await api.get("/projects", { ...args }));
}

export async function getProject(api: ApiClient, args: { id: string }) {
  return summarize(await api.get(`/projects/${encodeURIComponent(args.id)}`));
}

export async function projectStats(api: ApiClient) {
  return summarize(await api.get("/projects/stats"));
}

export async function listClips(
  api: ApiClient,
  args: { projectId?: string; page?: number; limit?: number; status?: string },
) {
  if (args.projectId) {
    return summarize(await api.get(`/clips/project/${encodeURIComponent(args.projectId)}`));
  }
  return summarize(await api.get("/clips", { page: args.page, limit: args.limit, status: args.status }));
}

export async function listVoices(api: ApiClient) {
  return summarize(await api.get("/voices"));
}

export async function getUsage(api: ApiClient) {
  return summarize(await api.get("/billing/usage"));
}

export async function listMovies(api: ApiClient, args: { projectId?: string }) {
  if (args.projectId) {
    return summarize(await api.get(`/movies/project/${encodeURIComponent(args.projectId)}`));
  }
  return summarize(await api.get("/movies"));
}

export function listEndpoints() {
  return { mcpServerUrl: getConfig().mcpServerUrl, groups: CATALOG };
}

/**
 * Guided, start-to-finish walkthrough of the whole pipeline (auth → project →
 * photos → edits → clips → audio/overlays → arrange → render). Returns a
 * numbered plan the assistant can follow step by step, plus the gotchas
 * (async polling, paid gating). Read-only; safe to call any time.
 */
export function help() {
  return {
    overview:
      "Drive the Reel Estate product end to end: create a project for a listing, add photos, " +
      "optionally edit them (staging/twilight/etc.), animate them into clips, lay in music/voiceover " +
      "and image/text overlays, arrange the timeline, then render the final movie.",
    firstTime:
      "Your first tool call opens a browser to sign in (or call `login`). Then call `whoami` — if " +
      "canWrite is false you're on a free plan (read-only over the MCP) and creating/generating is " +
      "blocked until you upgrade.",
    steps: [
      {
        n: 1,
        title: "Sign in & confirm access",
        tools: ["login", "whoami"],
        do: "Authenticate, then check whoami.canWrite. Free plans can browse but not create/generate.",
      },
      {
        n: 2,
        title: "Create a project for the listing",
        tools: ["resolve_address", "api_request"],
        do:
          "resolve_address to geocode the street address and pick a candidate (prefer isStreetLevel), " +
          "then create the project.",
        example: {
          resolve_address: { query: "1026 Amberley Crossing Dr, Belmont NC 28012" },
          create: { method: "POST", path: "/projects", body: { name: "1026 Amberley Crossing Dr", address: "<chosen candidate>" } },
        },
      },
      {
        n: 3,
        title: "Add photos",
        tools: ["add_image_from_file"],
        do:
          "Upload local image files (presigned, no storage creds). addToTimeline defaults true so each " +
          "photo becomes a video element in the render.",
        example: { add_image_from_file: { projectId: "<id>", path: "C:/photos/exterior.jpg", caption: "Front exterior" } },
      },
      {
        n: 4,
        title: "Edit photos (optional)",
        tools: ["edit_image", "get_project"],
        do:
          "Non-destructive versioned edits (staging, twilight, upscale, seasonal, replace/remove/add, " +
          "manual). Async — poll get_project to see the new active version. The active version is what " +
          "gets animated/rendered.",
        example: { edit_image: { projectId: "<id>", imageId: "<id>", editType: "twilight" } },
      },
      {
        n: 5,
        title: "Animate photos into clips",
        tools: ["generate_clip", "get_clip_status"],
        do:
          "Animate the active version of an image (auto/zoom/orbit/drone/custom). Async — poll " +
          "get_clip_status with the returned jobId. The finished clip auto-binds to its timeline element.",
        example: { generate_clip: { projectId: "<id>", imageId: "<id>", motion: "drone", duration: 5 } },
      },
      {
        n: 6,
        title: "Add music / voiceover / overlays (optional)",
        tools: ["add_timeline_audio", "add_timeline_overlay", "list_voices"],
        do:
          "Place an existing audio URL (music or a generated voiceover) at a point, and overlay a " +
          "project image/logo or a text caption. Get a voiceover url/durationSec from get_project " +
          "(project.voiceover / voiceovers[]). list_voices shows TTS voice presets.",
        example: {
          add_timeline_audio: { projectId: "<id>", url: "https://.../music.mp3", volume: 0.3 },
          add_timeline_overlay: { projectId: "<id>", text: "Just Listed", startTime: 0, duration: 3 },
        },
      },
      {
        n: 7,
        title: "Arrange the timeline (optional)",
        tools: ["reorder_timeline", "move_timeline_element", "get_project"],
        do:
          "reorder_timeline resequences the clip track (recomputes back-to-back timing); " +
          "move_timeline_element retimes a single floating audio/overlay element. Element ids come " +
          "from get_project (timeline.tracks[].elements[].id).",
        example: { reorder_timeline: { projectId: "<id>", order: ["<elementId2>", "<elementId1>"] } },
      },
      {
        n: 8,
        title: "Render the movie",
        tools: ["render_movie", "list_movies"],
        do:
          "Assemble the timeline into the final video (clips + music + overlays + auto-injected " +
          "voiceover). Async — poll list_movies; the finished movie has renderData.status='completed' " +
          "and a videoUrl. Costs credits + an export.",
        example: { render_movie: { projectId: "<id>" } },
      },
    ],
    notes: [
      "Async tools (edit_image, generate_clip, render_movie) return a jobId — poll rather than assume done.",
      "Writes/generation require a paid plan; reads (list_*, get_project, whoami) work on free.",
      "MCP-originated generation is bounded by a credit-velocity cap to prevent runaway spend.",
      "Anything not covered by a convenience tool is reachable via api_request (see list_endpoints).",
    ],
  };
}

export async function apiRequest(
  api: ApiClient,
  args: {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
  },
) {
  return summarize(
    await api.request({ method: args.method, path: args.path, query: args.query, body: args.body }),
  );
}

/** Surface HTTP status alongside the body so error envelopes are visible. */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "image/jpeg";
}

/**
 * Add a photo to a project from a LOCAL file — the passthrough the embedded
 * (remote) MCP can't do, since it has neither the user's filesystem nor a way
 * to move bytes that don't fit in the model's token budget. Three steps, none
 * of which need storage credentials:
 *   1. POST /projects/:id/images/upload-url  -> presigned S3 PUT URL + publicUrl
 *   2. PUT the file bytes straight to that URL (the signed URL IS the capability)
 *   3. POST /projects/:id/images { url, s3Key } -> attach (limit check, vision, SSE)
 */
export async function addImageFromFile(
  api: ApiClient,
  args: { projectId: string; path: string; caption?: string; filename?: string; addToTimeline?: boolean },
) {
  const buffer = await readFile(args.path);
  const name = args.filename ?? basename(args.path);
  const contentType = mimeFromName(name);

  // 1. Mint a presigned upload URL (authenticated as the user; no storage creds).
  const minted = await api.request({
    method: "POST",
    path: `/projects/${encodeURIComponent(args.projectId)}/images/upload-url`,
    body: { filename: name, contentType },
  });
  if (!minted.ok) return summarize(minted); // surface the API error envelope as-is
  const slot = (minted.data as { data?: { uploadUrl?: string; publicUrl?: string; s3Key?: string } })?.data;
  if (!slot?.uploadUrl || !slot.publicUrl || !slot.s3Key) {
    throw new Error(
      `upload-url response missing fields: ${JSON.stringify(minted.data).slice(0, 200)}`,
    );
  }

  // 2. PUT bytes directly to S3. Deliberately NO Authorization header — the
  //    presigned URL carries its own signature; an extra header would break it.
  const put = await fetch(slot.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    throw new Error(`Direct S3 upload failed: HTTP ${put.status} ${detail.slice(0, 200)}`);
  }

  // 3. Attach the uploaded object to the project.
  const attach = await api.request({
    method: "POST",
    path: `/projects/${encodeURIComponent(args.projectId)}/images`,
    body: {
      url: slot.publicUrl,
      s3Key: slot.s3Key,
      caption: args.caption,
      // Default on: also append a video timeline element so the image is part of
      // the render (the whole point of adding it). Pass false to skip.
      addToTimeline: args.addToTimeline ?? true,
    },
  });
  return summarize(attach);
}

/**
 * Geocode a free-text address into ranked candidates (formatted, placeId,
 * location, components). Use before creating a project for a real listing: pass
 * the chosen candidate as the project `address` so listing facts auto-populate.
 */
export async function resolveAddress(api: ApiClient, args: { query: string; limit?: number }) {
  return summarize(
    await api.request({
      method: "POST",
      path: "/addresses/resolve",
      body: { query: args.query, ...(args.limit ? { limit: args.limit } : {}) },
    }),
  );
}

/**
 * Animate a still project image into a video clip (Runway Gen-4). Async: returns
 * a jobId — poll with get_clip_status. If imageUrl is omitted it's resolved from
 * the project so the caller only needs projectId + imageId + motion.
 */
export async function generateClip(
  api: ApiClient,
  args: {
    projectId: string;
    imageId: string;
    motion: string;
    duration?: number;
    imageUrl?: string;
    customMotionPrompt?: string;
    aspectRatio?: string;
    resolution?: string;
    activeVersionId?: string;
    animatableElements?: string[];
  },
) {
  // Resolve from the project so we animate the ACTIVE version (e.g. a twilight
  // or destaged edit) and bind the clip to it — otherwise a render wouldn't
  // match this clip to the timeline element and would regenerate.
  const proj = await api.get(`/projects/${encodeURIComponent(args.projectId)}`);
  const images =
    (
      proj.data as {
        data?: {
          images?: Array<{
            _id?: string;
            url?: string;
            activeVersionId?: string;
            editedVersions?: Array<{ _id?: string; url?: string }>;
          }>;
        };
      }
    )?.data?.images ?? [];
  const img = images.find((i) => String(i._id) === args.imageId);
  if (!img) {
    throw new Error(`Image ${args.imageId} not found in project ${args.projectId}.`);
  }

  const activeVersionId = args.activeVersionId ?? img.activeVersionId;
  const activeVersion = activeVersionId
    ? (img.editedVersions ?? []).find((v) => String(v._id) === String(activeVersionId))
    : undefined;
  // Prefer an explicit override, else the active edited version, else the original.
  const imageUrl = args.imageUrl ?? activeVersion?.url ?? img.url;
  if (!imageUrl) {
    throw new Error(`Could not resolve an image URL for ${args.imageId}.`);
  }

  return summarize(
    await api.request({
      method: "POST",
      path: "/clip-generation/generate-single-clip",
      body: {
        projectId: args.projectId,
        imageId: args.imageId,
        imageUrl,
        motion: args.motion,
        duration: args.duration ?? 5,
        aspectRatio: args.aspectRatio,
        resolution: args.resolution,
        customMotionPrompt: args.customMotionPrompt,
        activeVersionId,
        animatableElements: args.animatableElements,
      },
    }),
  );
}

/** Poll a clip-generation job started by generate_clip. */
export async function getClipStatus(api: ApiClient, args: { jobId: string }) {
  return summarize(await api.get(`/clip-generation/clip-status/${encodeURIComponent(args.jobId)}`));
}

/**
 * Create a Gemini-powered edit of a project image (staging, twilight, upscale,
 * seasonal, replace/remove/add, or manual). Non-destructive — adds a new version
 * under the image. Async: returns a jobId; the version shows up on the image
 * (see get_project). Costs 1 credit.
 */
export async function editImage(
  api: ApiClient,
  args: {
    projectId: string;
    imageId: string;
    editType: string;
    roomType?: string;
    style?: string;
    advancedParams?: { target: string; value?: string };
    customPrompt?: string;
  },
) {
  return summarize(
    await api.request({
      method: "POST",
      path: "/image-editing/edit",
      body: {
        projectId: args.projectId,
        imageId: args.imageId,
        editType: args.editType,
        roomType: args.roomType,
        style: args.style,
        advancedParams: args.advancedParams,
        customPrompt: args.customPrompt,
      },
    }),
  );
}

/**
 * Render the project's timeline into the final movie (assembles clips, music,
 * watermark, overlays). Only projectId is required — everything else falls back
 * to the project's saved settings. Async: returns a jobId; poll list_movies or
 * /movies/check-status. Costs credits + an export.
 */
export async function renderMovie(
  api: ApiClient,
  args: { projectId: string; aiGeneratedLabel?: boolean; settings?: Record<string, unknown> },
) {
  return summarize(
    await api.request({
      method: "POST",
      path: "/video-generation/generate-full-video",
      body: {
        projectId: args.projectId,
        ...(args.aiGeneratedLabel !== undefined ? { aiGeneratedLabel: args.aiGeneratedLabel } : {}),
        ...(args.settings ? { settings: args.settings } : {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Timeline editing (audio / overlays / arrangement)
//
// The render is driven ENTIRELY by the timeline's tracks — an asset that isn't
// a timeline element is invisible to it. The UI edits the timeline object and
// PUTs it back; these tools do the same read-modify-write so non-UI clients can
// place existing voice tracks, music, images, and text at specific points, and
// rearrange elements. Audio/overlay/text elements MUST live on `generic` tracks
// — the render mapper only turns `video` and `generic` track elements into
// overlays. A full-timeline PUT re-validates every element, so this depends on
// nothing beyond the already-audited PUT /projects/:id endpoint.
// ---------------------------------------------------------------------------

interface TimelineElement {
  id: string;
  startTime: number;
  duration: number;
  transition?: string;
  videoConfig?: Record<string, unknown>;
  audioConfig?: Record<string, unknown>;
  imageConfig?: Record<string, unknown>;
  textConfig?: Record<string, unknown>;
  stickerConfig?: Record<string, unknown>;
  [k: string]: unknown;
}
interface TimelineTrack {
  id: string;
  type: "video" | "generic" | "watermark";
  name?: string;
  elements: TimelineElement[];
  [k: string]: unknown;
}
interface Timeline {
  tracks: TimelineTrack[];
  magneticTrackIds?: string[];
  [k: string]: unknown;
}

/** The zod timeline validator requires every element duration >= 0.5s. */
function clampDuration(d?: number): number {
  const n = typeof d === "number" && Number.isFinite(d) ? d : 5;
  return Math.max(n, 0.5);
}

/** Load the project and its timeline (defaulting an empty one) for editing. */
async function fetchProjectTimeline(
  api: ApiClient,
  projectId: string,
): Promise<{ project: any; timeline: Timeline }> {
  const res = await api.get(`/projects/${encodeURIComponent(projectId)}`);
  if (!res.ok) {
    throw new Error(`Could not load project ${projectId}: HTTP ${res.status}`);
  }
  const project = ((res.data as { data?: unknown })?.data ?? res.data) as any;
  const timeline: Timeline = project?.timeline ?? { tracks: [] };
  if (!Array.isArray(timeline.tracks)) timeline.tracks = [];
  return { project, timeline };
}

/** PUT just the timeline back — narrow body keeps the blast radius small. */
async function saveTimeline(api: ApiClient, projectId: string, timeline: Timeline) {
  return api.request({
    method: "PUT",
    path: `/projects/${encodeURIComponent(projectId)}`,
    body: { timeline },
  });
}

/** Find (or lazily create) a named generic track for overlays/audio layers. */
function findOrCreateGenericTrack(timeline: Timeline, name: string): TimelineTrack {
  let track = timeline.tracks.find((t) => t.type === "generic" && t.name === name);
  if (!track) {
    track = { id: randomUUID(), type: "generic", name, elements: [] };
    timeline.tracks.push(track);
  }
  if (!Array.isArray(track.elements)) track.elements = [];
  return track;
}

/** Sum of the video track's element durations — the movie length in seconds. */
function totalVideoDuration(timeline: Timeline): number {
  const v = timeline.tracks.find((t) => t.type === "video");
  return (v?.elements ?? []).reduce((s, e) => s + (e.duration || 0), 0);
}

function findElement(
  timeline: Timeline,
  elementId: string,
): { track: TimelineTrack; element: TimelineElement } | null {
  for (const track of timeline.tracks) {
    const element = (track.elements ?? []).find((e) => e.id === elementId);
    if (element) return { track, element };
  }
  return null;
}

/**
 * Place an EXISTING audio asset (a generated voiceover, a music track, any audio
 * URL) on the timeline at a specific point. Lives on a generic "Audio" track so
 * the render maps it to a SoundOverlay. duration defaults to the full movie
 * length (good for background music); pass sourceDuration for a fixed clip like
 * a voiceover. Get a voiceover's url/durationSec from get_project (project
 * .voiceover / .voiceovers[]); music can be any public URL.
 */
export async function addTimelineAudio(
  api: ApiClient,
  args: {
    projectId: string;
    url: string;
    startTime?: number;
    duration?: number;
    volume?: number;
    fadeIn?: number;
    fadeOut?: number;
    title?: string;
    s3Key?: string;
    sourceDuration?: number;
  },
) {
  const { timeline } = await fetchProjectTimeline(api, args.projectId);
  const track = findOrCreateGenericTrack(timeline, "Audio");
  const duration = clampDuration(
    args.duration ?? args.sourceDuration ?? (totalVideoDuration(timeline) || 5),
  );
  track.elements.push({
    id: randomUUID(),
    startTime: args.startTime ?? 0,
    duration,
    audioConfig: {
      url: args.url,
      ...(args.s3Key ? { s3Key: args.s3Key } : {}),
      volume: args.volume ?? 1,
      ...(args.fadeIn !== undefined ? { fadeIn: args.fadeIn } : {}),
      ...(args.fadeOut !== undefined ? { fadeOut: args.fadeOut } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.sourceDuration !== undefined ? { sourceDuration: args.sourceDuration } : {}),
    },
  });
  return summarize(await saveTimeline(api, args.projectId, timeline));
}

/**
 * Place an EXISTING image/logo OR a text caption on the timeline as an overlay
 * at a specific point. Image source is either an imageId already in the project
 * (url auto-resolved) or a direct url; pass `text` instead for a text overlay.
 * Lives on a generic "Overlays" track so the render maps it to an Image/Text
 * overlay. Position is percent-of-canvas (0-100) from the top-left.
 */
export async function addTimelineOverlay(
  api: ApiClient,
  args: {
    projectId: string;
    imageId?: string;
    url?: string;
    s3Key?: string;
    text?: string;
    fontColor?: string;
    fontSize?: number;
    startTime?: number;
    duration?: number;
    position?: { x: number; y: number };
    opacity?: number;
    size?: number;
  },
) {
  const { project, timeline } = await fetchProjectTimeline(api, args.projectId);
  const track = findOrCreateGenericTrack(timeline, "Overlays");
  const element: TimelineElement = {
    id: randomUUID(),
    startTime: args.startTime ?? 0,
    duration: clampDuration(args.duration ?? 5),
  };

  if (args.text) {
    element.textConfig = {
      text: args.text,
      ...(args.position ? { position: args.position } : {}),
      // style is all-or-nothing in the validator, so populate sane defaults.
      style: {
        fontSize: args.fontSize ?? 32,
        fontFamily: "Arial",
        fontColor: args.fontColor ?? "#FFFFFF",
        ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
      },
    };
  } else {
    let url = args.url;
    let s3Key = args.s3Key;
    if (!url && args.imageId) {
      const img = ((project.images ?? []) as Array<{ _id?: string; url?: string; s3Key?: string }>).find(
        (i) => String(i._id) === args.imageId,
      );
      if (!img) throw new Error(`Image ${args.imageId} not found in project ${args.projectId}.`);
      url = img.url;
      s3Key = img.s3Key;
    }
    if (!url) throw new Error("Provide one of: imageId, url, or text for the overlay.");
    element.imageConfig = {
      url,
      ...(s3Key ? { s3Key } : {}),
      ...(args.position ? { position: args.position } : {}),
      ...(args.size !== undefined ? { size: args.size } : {}),
      ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
    };
  }

  track.elements.push(element);
  return summarize(await saveTimeline(api, args.projectId, timeline));
}

/**
 * Retime a single timeline element (any track) — change when it starts and/or
 * how long it lasts. Use for nudging a floating audio/overlay element to a new
 * point. For resequencing the whole video track, use reorder_timeline instead.
 */
export async function moveTimelineElement(
  api: ApiClient,
  args: { projectId: string; elementId: string; startTime?: number; duration?: number },
) {
  const { timeline } = await fetchProjectTimeline(api, args.projectId);
  const found = findElement(timeline, args.elementId);
  if (!found) throw new Error(`Timeline element ${args.elementId} not found in project ${args.projectId}.`);
  if (args.startTime !== undefined) found.element.startTime = args.startTime;
  if (args.duration !== undefined) found.element.duration = clampDuration(args.duration);
  return summarize(await saveTimeline(api, args.projectId, timeline));
}

/**
 * Reorder the elements of a track (defaults to the video track) and recompute
 * sequential startTimes so they play back-to-back in the given order. Pass the
 * element ids in the desired order; any elements you omit keep their relative
 * order and are appended after. This is the "rearrange the clips" operation.
 */
export async function reorderTimeline(
  api: ApiClient,
  args: { projectId: string; order: string[]; trackId?: string; gap?: number },
) {
  const { timeline } = await fetchProjectTimeline(api, args.projectId);
  const track = args.trackId
    ? timeline.tracks.find((t) => t.id === args.trackId)
    : timeline.tracks.find((t) => t.type === "video");
  if (!track) throw new Error(args.trackId ? `Track ${args.trackId} not found.` : "No video track to reorder.");

  const byId = new Map(track.elements.map((e) => [e.id, e]));
  const reordered: TimelineElement[] = [];
  for (const id of args.order) {
    const e = byId.get(id);
    if (!e) throw new Error(`Element ${id} is not on the target track.`);
    reordered.push(e);
  }
  // Keep any elements the caller didn't mention, in their existing order.
  for (const e of track.elements) if (!args.order.includes(e.id)) reordered.push(e);

  const gap = args.gap ?? 0;
  let t = 0;
  for (const e of reordered) {
    e.startTime = t;
    t += (e.duration || 0) + gap;
  }
  track.elements = reordered;
  return summarize(await saveTimeline(api, args.projectId, timeline));
}

function summarize(res: { status: number; ok: boolean; method: string; url: string; data: unknown }) {
  return {
    status: res.status,
    ok: res.ok,
    request: `${res.method} ${res.url}`,
    data: res.data,
  };
}
