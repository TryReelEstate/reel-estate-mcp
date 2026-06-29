/**
 * Curated catalog of the Reel Estate API surface, grouped by mount prefix.
 *
 * This is documentation the assistant can read at runtime (via the
 * `list_endpoints` tool) so it knows which paths the generic `api_request`
 * tool can hit. Paths are relative to the API base (".../api/v1"). It is NOT
 * exhaustive — every mounted route is reachable via api_request — but it covers
 * the user-facing surface. `:param` segments are path parameters.
 *
 * Auth: all listed endpoints require the authenticated user's session unless
 * noted. Admin endpoints additionally require role=admin on the user.
 */

export interface EndpointGroup {
  group: string;
  prefix: string;
  endpoints: Array<{ method: string; path: string; note?: string }>;
}

export const CATALOG: EndpointGroup[] = [
  {
    group: "Projects",
    prefix: "/projects",
    endpoints: [
      { method: "GET", path: "/projects", note: "list (query: page, limit, sortBy, sortOrder, status, folderId, search, starred)" },
      { method: "GET", path: "/projects/recent", note: "most recently updated (query: limit)" },
      { method: "GET", path: "/projects/stats" },
      { method: "GET", path: "/projects/:id" },
      { method: "POST", path: "/projects", note: "create" },
      { method: "PUT", path: "/projects/:id", note: "update" },
      { method: "DELETE", path: "/projects/:id" },
      { method: "POST", path: "/projects/:id/duplicate" },
      { method: "POST", path: "/projects/:id/images", note: "add image by URL" },
      { method: "DELETE", path: "/projects/:id/images/:imageId" },
      { method: "PUT", path: "/projects/:id/images/reorder" },
      { method: "POST", path: "/projects/:projectId/voiceover/script", note: "generate narration script" },
      { method: "POST", path: "/projects/:projectId/voiceover", note: "synthesize voiceover (async, 202)" },
      { method: "POST", path: "/projects/:projectId/voiceover/select" },
      { method: "DELETE", path: "/projects/:projectId/voiceover" },
    ],
  },
  {
    group: "Clips",
    prefix: "/clips",
    endpoints: [
      { method: "GET", path: "/clips", note: "clip library (query: page, limit, status)" },
      { method: "GET", path: "/clips/project/:projectId" },
      { method: "GET", path: "/clips/download", note: "query: clipId" },
      { method: "DELETE", path: "/clips/:id" },
    ],
  },
  {
    group: "Clip & video generation",
    prefix: "/clip-generation, /video-generation, /movies",
    endpoints: [
      { method: "GET", path: "/clip-generation/clip-status/:jobId" },
      { method: "GET", path: "/movies", note: "list rendered movies" },
      { method: "GET", path: "/movies/recent" },
      { method: "GET", path: "/movies/project/:projectId" },
      { method: "GET", path: "/movies/check-status/:movieId" },
    ],
  },
  {
    group: "Images & image editing",
    prefix: "/images, /image-editing",
    endpoints: [
      { method: "GET", path: "/images", note: "user's photo library" },
      { method: "GET", path: "/images/project/:projectId" },
      { method: "GET", path: "/images/download", note: "query: ..." },
      { method: "POST", path: "/images/import" },
      { method: "DELETE", path: "/images/:projectId/images/:imageId" },
    ],
  },
  {
    group: "Voiceover voices",
    prefix: "/voices",
    endpoints: [
      { method: "GET", path: "/voices", note: "available voices (stock + cloned)" },
      { method: "POST", path: "/voices/clone", note: "instant voice clone" },
      { method: "PATCH", path: "/voices/:voiceId/default" },
      { method: "DELETE", path: "/voices/:voiceId" },
    ],
  },
  {
    group: "User profile",
    prefix: "/users",
    endpoints: [
      { method: "GET", path: "/users/profile", note: "current authenticated user" },
      { method: "PUT", path: "/users/profile", note: "update profile / preferences" },
      { method: "DELETE", path: "/users/watermark" },
    ],
  },
  {
    group: "Billing & credits",
    prefix: "/billing, /credits",
    endpoints: [
      { method: "GET", path: "/billing/usage", note: "credit/export usage for current user" },
      { method: "GET", path: "/billing/can-generate" },
      { method: "GET", path: "/billing/can-export" },
      { method: "GET", path: "/billing/plans" },
      { method: "GET", path: "/credits/packages" },
      { method: "GET", path: "/credits/history" },
    ],
  },
  {
    group: "Folders",
    prefix: "/folders",
    endpoints: [
      { method: "GET", path: "/folders" },
      { method: "POST", path: "/folders" },
      { method: "PUT", path: "/folders/:id" },
      { method: "DELETE", path: "/folders/:id" },
    ],
  },
  {
    group: "Staging utilities (staging/dev API only)",
    prefix: "/staging",
    endpoints: [
      { method: "GET", path: "/staging/info" },
      { method: "POST", path: "/staging/switch-plan", note: "body: { plan: 'pro' | 'free' }" },
      { method: "POST", path: "/staging/reset-usage" },
    ],
  },
  {
    group: "Support & misc",
    prefix: "/support, /testimonials, /banners, /upsell",
    endpoints: [
      { method: "GET", path: "/banners/active" },
      { method: "GET", path: "/upsell" },
      { method: "POST", path: "/support", note: "create a support ticket" },
      { method: "GET", path: "/testimonials" },
    ],
  },
  {
    group: "Admin (requires role=admin)",
    prefix: "/admin",
    endpoints: [
      { method: "GET", path: "/admin/users", note: "query: page, limit, search, plan, status" },
      { method: "GET", path: "/admin/users/:id" },
      { method: "GET", path: "/admin/stats" },
      { method: "GET", path: "/admin/analytics/plans" },
      { method: "GET", path: "/admin/analytics/credit-utilization" },
      { method: "GET", path: "/admin/audit-logs" },
    ],
  },
];
