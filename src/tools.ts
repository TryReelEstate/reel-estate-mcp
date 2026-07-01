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

export async function whoami(api: ApiClient) {
  const { mcpServerUrl, readOnly } = getConfig();
  const profile = await api.get("/users/profile");
  return {
    mcpServerUrl,
    readOnly,
    authenticated: profile.ok,
    profileStatus: profile.status,
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
