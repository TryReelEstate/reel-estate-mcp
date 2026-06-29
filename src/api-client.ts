import { getConfig } from "./config.js";
import { ClerkSession } from "./clerk-session.js";

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
 * Thin authenticated HTTP client for the Reel Estate API. Injects a fresh
 * Clerk bearer token on every call and unwraps JSON. Never throws on non-2xx —
 * the status + parsed body are returned so the model can see API error shapes
 * ({ error: { code, message } }).
 */
export class ApiClient {
  constructor(private readonly session: ClerkSession) {}

  private buildUrl(path: string, query?: ApiRequest["query"]): string {
    const { apiBaseUrl } = getConfig();
    const clean = path.replace(/^\/+/, "");
    const url = new URL(`${apiBaseUrl}/${clean}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request(req: ApiRequest): Promise<ApiResponse> {
    const { readOnly } = getConfig();
    if (readOnly && req.method !== "GET") {
      throw new Error(
        `MCP_READONLY is set — refusing ${req.method} ${req.path}. ` +
          `Unset MCP_READONLY to allow mutating requests.`,
      );
    }

    const url = this.buildUrl(req.path, req.query);
    const token = await this.session.getToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let bodyInit: string | undefined;
    if (req.body !== undefined && req.method !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(req.body);
    }

    const res = await fetch(url, { method: req.method, headers, body: bodyInit });

    const text = await res.text();
    let data: unknown = text;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { status: res.status, ok: res.ok, url, method: req.method, data };
  }

  get(path: string, query?: ApiRequest["query"]) {
    return this.request({ method: "GET", path, query });
  }
}
