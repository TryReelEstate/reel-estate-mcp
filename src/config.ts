import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** When true, only GET requests are permitted (mutating tools are blocked). */
  readOnly: boolean;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const rawServer = process.env.MCP_SERVER_URL ?? process.env.API_BASE_URL;
  if (!rawServer || !rawServer.trim()) {
    throw new Error(
      "Missing MCP_SERVER_URL — the backend origin hosting the /mcp endpoint " +
        "(e.g. https://your-backend.herokuapp.com). Copy .env.example to .env and set it.",
    );
  }

  const callbackPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT ?? 8765) || 8765;

  cached = {
    mcpServerUrl: deriveMcpUrl(rawServer),
    oauthStoreDir: process.env.MCP_OAUTH_STORE_DIR ?? join(homedir(), ".reel-estate-mcp"),
    callbackPort,
    redirectUrl: `http://localhost:${callbackPort}/callback`,
    scope: process.env.MCP_OAUTH_SCOPE?.trim() || undefined,
    readOnly: /^(1|true|yes)$/i.test(process.env.MCP_READONLY ?? ""),
  };
  return cached;
}
