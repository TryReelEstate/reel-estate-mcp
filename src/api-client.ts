import { getConfig } from "./config.js";
import { callApiRequest } from "./upstream.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequest {
  method: HttpMethod;
  /** Path relative to the API base, e.g. "/projects" or "projects/123". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  url: string;
  method: HttpMethod;
  data: unknown;
}

/**
 * API client that proxies every call through the backend's `/mcp` `api_request`
 * tool (see upstream.ts) instead of hitting REST directly. Auth lives entirely
 * in the upstream OAuth connection — there are no tokens or secrets here. The
 * tool functions in tools.ts are unchanged: they still see the same
 * `{ status, ok, url, method, data }` shape and never throw on non-2xx.
 */
export class ApiClient {
  async request(req: ApiRequest): Promise<ApiResponse> {
    const { readOnly } = getConfig();
    if (readOnly && req.method !== "GET") {
      throw new Error(
        `MCP_READONLY is set — refusing ${req.method} ${req.path}. ` +
          `Unset MCP_READONLY to allow mutating requests.`,
      );
    }

    // Drop undefined query values so we don't send "undefined" strings upstream.
    let query: Record<string, string | number | boolean> | undefined;
    if (req.query) {
      query = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined) query[k] = v;
      }
    }

    const res = await callApiRequest({ method: req.method, path: req.path, query, body: req.body });

    // The upstream `api_request` summary is `{ status, ok, request: "GET <url>", data }`.
    const requestStr = typeof res.request === "string" ? res.request : `${req.method} ${req.path}`;
    const sep = requestStr.indexOf(" ");
    const method = (sep > 0 ? requestStr.slice(0, sep) : req.method) as HttpMethod;
    const url = sep > 0 ? requestStr.slice(sep + 1) : req.path;

    return { status: res.status, ok: res.ok, url, method, data: res.data };
  }

  get(path: string, query?: ApiRequest["query"]) {
    return this.request({ method: "GET", path, query });
  }
}
