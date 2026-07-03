import { config as loadEnv } from "dotenv";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from THIS package's root (one level up from src/), NOT the process
// cwd. The MCP client launches us with an arbitrary working directory, so the
// default cwd-relative loading silently dropped our config (e.g.
// MCP_OAUTH_CLIENT_ID → unintended DCR fallback). Any real env var already set by
// the client still wins (dotenv doesn't override existing process.env).
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

/** Default backend when MCP_SERVER_URL isn't set — Reel Estate production. */
const DEFAULT_SERVER_URL = "https://api.tryreelestate.com";

/**
 * Built-in public OAuth client ids, keyed by backend host. These are PUBLIC
 * clients (PKCE, no secret), so shipping them in source is safe and lets the
 * bridge authenticate with zero config.
 *
 * A client id is only valid on the Clerk instance that issued it, so the default
 * is chosen by host. For any other backend (e.g. a self-hosted deployment on its
 * own Clerk instance), set MCP_OAUTH_CLIENT_ID explicitly.
 */
const DEFAULT_CLIENT_ID_BY_HOST: Record<string, string> = {
  "api.tryreelestate.com": "to8vyZYVhk0BL18o", // production (.com Clerk instance)
  "api.tryreelestate.dev": "rIaBig0Snca4mzrC", // dev/staging (clerk.tryreelestate.dev)
  "reel-estate-staging-c69e8a83d6df.herokuapp.com": "rIaBig0Snca4mzrC", // staging dyno
};

/** The built-in public client id for a backend URL, or undefined if unknown. */
function defaultClientIdFor(serverUrl: string): string | undefined {
  try {
    return DEFAULT_CLIENT_ID_BY_HOST[new URL(serverUrl).host.toLowerCase()];
  } catch {
    return undefined;
  }
}

/**
 * Centralized, validated configuration.
 *
 * This server is an **OAuth client of the backend's embedded `/mcp` endpoint**.
 * It does NOT mint Clerk sessions and needs NO secret key — the user signs in
 * through their browser once, and tokens are cached locally. All API calls are
 * proxied through `/mcp` (the backend is the auth authority), so this server's
 * only privileged job is local file access (e.g. add_image_from_file).
 */

function deriveMcpUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  // Accept a bare origin and append the MCP mount path. NOTE: `/mcp` is mounted
  // on the BACKEND origin (the API host), not the marketing site.
  if (!/\/mcp$/.test(url)) url = `${url}/mcp`;
  return url;
}

export interface Config {
  /** Full URL to the backend's MCP endpoint, e.g. https://api.example.com/mcp */
  mcpServerUrl: string;
  /** Directory where OAuth client registration + tokens are cached. */
  oauthStoreDir: string;
  /** Loopback port the browser is redirected back to after authorization. */
  callbackPort: number;
  /** Computed redirect URI (must match the registered client). */
  redirectUrl: string;
  /** Optional OAuth scope override; omitted -> negotiated from server metadata. */
  scope?: string;
  /**
   * Pre-registered public OAuth client id used for the browser login (public
   * client + PKCE — no secret). Resolved from MCP_OAUTH_CLIENT_ID, else the
   * built-in default for the backend host. Undefined only for an unknown backend
   * with no explicit id set (login then can't proceed — set MCP_OAUTH_CLIENT_ID).
   */
  oauthClientId?: string;
  /** When true, only GET requests are permitted (mutating tools are blocked). */
  readOnly: boolean;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  // Defaults to Reel Estate production; override with MCP_SERVER_URL for staging
  // or a self-hosted backend.
  const rawServer = (
    process.env.MCP_SERVER_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    DEFAULT_SERVER_URL
  );

  const callbackPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT ?? 8765) || 8765;

  cached = {
    mcpServerUrl: deriveMcpUrl(rawServer),
    oauthStoreDir: process.env.MCP_OAUTH_STORE_DIR ?? join(homedir(), ".reel-estate-mcp"),
    callbackPort,
    redirectUrl: `http://localhost:${callbackPort}/callback`,
    scope: process.env.MCP_OAUTH_SCOPE?.trim() || undefined,
    oauthClientId: process.env.MCP_OAUTH_CLIENT_ID?.trim() || defaultClientIdFor(rawServer),
    readOnly: /^(1|true|yes)$/i.test(process.env.MCP_READONLY ?? ""),
  };
  return cached;
}
