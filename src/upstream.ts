import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { getConfig } from "./config.js";
import { FileOAuthProvider, openBrowser } from "./oauth.js";

/**
 * Maintains ONE connection to the backend's `/mcp`, authenticated as the user
 * via OAuth (browser login on first run, cached tokens after). Every API call
 * is proxied through the upstream `api_request` tool, so the backend remains
 * the single auth authority — this server holds no credentials, only tokens.
 */

let clientPromise: Promise<Client> | null = null;

/** Loopback server that catches the OAuth redirect and yields the `code`. */
function startCallbackServer(port: number): { waitForCode: Promise<string>; close: () => void } {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const waitForCode = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body style='font-family:sans-serif'><h3>Authorized ✓</h3>" +
          "<p>You can close this tab and return to your terminal.</p></body></html>",
      );
      if (code) resolve(code);
      else reject(new Error(`Authorization failed: ${error ?? "no code returned"}`));
    } catch (err) {
      reject(err as Error);
    }
  });
  // Don't crash the process if the port is busy — surface it via waitForCode.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      reject(
        new Error(
          `OAuth callback port ${port} is already in use — another reel-estate-mcp instance is ` +
            `probably mid-authorization. Kill stale server processes (or set MCP_OAUTH_CALLBACK_PORT) and retry.`,
        ),
      );
    } else {
      reject(err);
    }
  });
  server.listen(port);

  return { waitForCode, close: () => { try { server.close(); } catch { /* noop */ } } };
}

async function connect(): Promise<Client> {
  const cfg = getConfig();
  // Normal tool calls must NEVER trigger an interactive browser flow — a stdio
  // server launched by a GUI client can't reliably pop one, so it would just
  // hang. Use the cached token, or fail fast with guidance to run `login`.
  const provider = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, () => {});

  if (!(await provider.tokens())) {
    throw new Error(
      "Not authenticated. Run the `login` tool (or `npm run login` in a terminal) to sign in, then retry.",
    );
  }

  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpServerUrl), { authProvider: provider });
  const client = new Client({ name: "reel-estate-mcp-bridge", version: "0.3.0" });
  try {
    // Uses the cached access token; the SDK refreshes it silently if expired.
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw new Error(
        "Session expired or was revoked. Run the `login` tool (or `npm run login`) to sign in again.",
      );
    }
    throw err;
  }

  console.error(`[reel-estate-mcp] connected to ${cfg.mcpServerUrl}`);
  return client;
}

/**
 * Interactive login. A stdio server can't reliably open a browser and its
 * stderr isn't visible in a GUI client, so this RETURNS the authorization URL
 * for the user to open, and finishes the token exchange in the background when
 * they approve (the loopback catches the redirect). It also best-effort opens a
 * browser — which works when run from a terminal (`npm run login`), where the
 * caller can await `completion`.
 */
export async function login(): Promise<{
  status: "authenticated" | "authorization_required";
  authorizeUrl?: string;
  message: string;
  completion?: Promise<void>;
}> {
  const cfg = getConfig();

  const probe = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, () => {});
  if (await probe.tokens()) {
    return { status: "authenticated", message: "Already logged in. Use the `logout` tool to switch accounts." };
  }

  const ref: { callback: { waitForCode: Promise<string>; close: () => void } | null } = { callback: null };
  let authorizeUrl: string | undefined;
  const onAuthorize = (url: string) => {
    authorizeUrl = url;
    if (!ref.callback) ref.callback = startCallbackServer(cfg.callbackPort);
    openBrowser(url); // reliable only from a terminal; harmless otherwise
  };

  const provider = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, onAuthorize);
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpServerUrl), { authProvider: provider });
  const client = new Client({ name: "reel-estate-mcp-bridge", version: "0.3.0" });

  try {
    await client.connect(transport);
    await client.close().catch(() => {});
    ref.callback?.close();
    return { status: "authenticated", message: "Logged in." };
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !ref.callback || !authorizeUrl) {
      ref.callback?.close();
      throw err;
    }
  }

  const cb = ref.callback;
  const completion = (async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("login timed out (no authorization within 5 minutes)")), 300_000);
    });
    try {
      const code = await Promise.race([cb.waitForCode, timeout]);
      await transport.finishAuth(code); // exchanges the code, persists the token
      if (clientPromise) {
        try {
          (await clientPromise).close();
        } catch {
          /* noop */
        }
        clientPromise = null;
      }
    } finally {
      if (timer) clearTimeout(timer);
      cb.close();
    }
  })();

  return {
    status: "authorization_required",
    authorizeUrl,
    message:
      "Open this URL in a browser to sign in, then retry your action (a browser may have opened automatically).",
    completion,
  };
}

/** Lazily establish (and memoize) the upstream connection. */
export function getClient(): Promise<Client> {
  if (!clientPromise) {
    // Do NOT cache a rejected promise — otherwise one failed auth bricks the
    // server until restart (every later tool call replays the same error).
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Call a tool on the upstream MCP server; returns its parsed JSON payload. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getClient();
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `Upstream tool ${name} returned an error`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ProxiedApiRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** Proxy a REST call through the upstream `api_request` tool. */
export async function callApiRequest(
  req: ProxiedApiRequest,
): Promise<{ status: number; ok: boolean; request?: string; data: unknown }> {
  const out = await callTool("api_request", {
    method: req.method,
    path: req.path,
    ...(req.query ? { query: req.query } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  return out as { status: number; ok: boolean; request?: string; data: unknown };
}

export async function close(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    /* best-effort */
  }
}

/** Best-effort RFC 7009 token revocation at the discovered auth server. */
async function revokeToken(mcpServerUrl: string, token: string, clientId: string): Promise<boolean> {
  const resource = await discoverOAuthProtectedResourceMetadata(mcpServerUrl);
  const authServer = resource?.authorization_servers?.[0];
  if (!authServer) return false;
  const meta = await discoverAuthorizationServerMetadata(authServer);
  // The SDK's metadata type omits revocation_endpoint, but Clerk (and RFC 8414)
  // provide it; read it through a cast.
  const endpoint = (meta as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!endpoint) return false;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: clientId }),
  });
  return res.ok; // RFC 7009 returns 200 even if the token was already invalid
}

/**
 * Log out: best-effort revoke the cached token server-side, clear the local
 * session (tokens + PKCE verifier + DCR client registration), and drop the
 * in-memory connection so the next tool call re-authorizes via the browser with
 * a fresh client registration.
 */
export async function logout(): Promise<{ clearedTokens: boolean; revoked: boolean; note?: string }> {
  const cfg = getConfig();
  const provider = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, () => {});

  let revoked = false;
  let note: string | undefined;
  try {
    const tokens = await provider.tokens();
    const info = (await provider.clientInformation()) as { client_id?: string } | undefined;
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (token && info?.client_id) {
      revoked = await revokeToken(cfg.mcpServerUrl, token, info.client_id);
    }
  } catch (err) {
    note = `server-side revocation skipped: ${err instanceof Error ? err.message : String(err)}`;
  }

  await provider.clearSession();

  if (clientPromise) {
    try {
      const client = await clientPromise;
      await client.close();
    } catch {
      /* noop */
    }
    clientPromise = null;
  }

  return { clearedTokens: true, revoked, note };
}
