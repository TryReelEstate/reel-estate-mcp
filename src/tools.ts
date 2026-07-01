import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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
  args: { projectId: string; path: string; caption?: string; filename?: string },
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
    body: { url: slot.publicUrl, s3Key: slot.s3Key, caption: args.caption },
  });
  return summarize(attach);
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
  let imageUrl = args.imageUrl;
  if (!imageUrl) {
    const proj = await api.get(`/projects/${encodeURIComponent(args.projectId)}`);
    const images = (proj.data as { data?: { images?: Array<{ _id?: string; url?: string }> } })?.data?.images ?? [];
    const img = images.find((i) => String(i._id) === args.imageId);
    if (!img?.url) {
      throw new Error(`Could not resolve imageUrl: image ${args.imageId} not found in project ${args.projectId}. Pass imageUrl explicitly.`);
    }
    imageUrl = img.url;
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
        activeVersionId: args.activeVersionId,
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

function summarize(res: { status: number; ok: boolean; method: string; url: string; data: unknown }) {
  return {
    status: res.status,
    ok: res.ok,
    request: `${res.method} ${res.url}`,
    data: res.data,
  };
}
