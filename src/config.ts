import "dotenv/config";

/**
 * Centralized, validated configuration for the MCP server.
 *
 * The server authenticates as ONE user (MCP_USER) using a Clerk Backend API
 * secret key, then calls the Reel Estate HTTP API as that user.
 *
 * IMPORTANT — instance matching: a Clerk session token is only accepted by an
 * API that trusts the SAME Clerk instance. Test keys (sk_test_/pk_test_) pair
 * with staging/localhost; live keys (sk_live_/pk_live_) pair with production
 * (https://tryreelestate.com). Mismatched pairs authenticate at Clerk but get
 * 401 INVALID_TOKEN from the API.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in, ` +
        `or pass it in the MCP server's "env" config block.`,
    );
  }
  return v.trim();
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  // Accept a bare origin and append the API prefix the app mounts everything under.
  if (!/\/api\/v\d+$/.test(url)) {
    url = `${url}/api/v1`;
  }
  return url;
}

export interface Config {
  clerkSecretKey: string;
  /** Email address OR Clerk user id (user_...) to authenticate as. */
  user: string;
  apiBaseUrl: string;
  /** Seconds of life requested for each minted session token. */
  tokenTtlSeconds: number;
  /** When true, only GET requests are permitted. */
  readOnly: boolean;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  cached = {
    clerkSecretKey: required("CLERK_SECRET_KEY"),
    user: required("MCP_USER"),
    apiBaseUrl: normalizeBaseUrl(process.env.API_BASE_URL ?? "https://tryreelestate.com"),
    tokenTtlSeconds: Number(process.env.MCP_TOKEN_TTL_SECONDS ?? 3600) || 3600,
    readOnly: /^(1|true|yes)$/i.test(process.env.MCP_READONLY ?? ""),
  };
  return cached;
}
