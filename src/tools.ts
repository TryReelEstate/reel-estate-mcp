import { ApiClient, type HttpMethod } from "./api-client.js";
import { ClerkSession } from "./clerk-session.js";
import { CATALOG } from "./catalog.js";
import { getConfig } from "./config.js";

/**
 * Tool implementations as plain functions over an ApiClient. The MCP layer
 * (index.ts) serializes their return values; the smoke test calls them
 * directly. Convenience tools are thin wrappers over specific endpoints;
 * `apiRequest` is the general escape hatch that can hit any route.
 */

export async function whoami(session: ClerkSession, api: ApiClient) {
  const { apiBaseUrl, user, readOnly } = getConfig();
  // Call the API first so the session is established before we read identity
  // (otherwise sessionId reads as null on the very first call).
  const profile = await api.get("/users/profile");
  const identity = await session.identity();
  return {
    configuredUser: user,
    clerkUserId: identity.clerkUserId,
    sessionId: identity.sessionId,
    apiBaseUrl,
    readOnly,
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
  return { apiBaseUrl: getConfig().apiBaseUrl, groups: CATALOG };
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
function summarize(res: { status: number; ok: boolean; method: string; url: string; data: unknown }) {
  return {
    status: res.status,
    ok: res.ok,
    request: `${res.method} ${res.url}`,
    data: res.data,
  };
}
