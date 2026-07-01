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

  // Start the loopback callback listener LAZILY — only when the OAuth flow
  // actually needs the browser (no valid cached token). Binding it eagerly on
  // every connect hogs the fixed port and collides with any other instance
  // mid-auth (the EADDRINUSE we hit). When cached tokens work, the port is
  // never touched.
  // Held in an object so TypeScript tracks the closure assignment below.
  const ref: { callback: { waitForCode: Promise<string>; close: () => void } | null } = { callback: null };
  const onAuthorize = (url: string) => {
    if (!ref.callback) ref.callback = startCallbackServer(cfg.callbackPort);
    console.error(`[reel-estate-mcp] authorization required — opening browser (callback ${cfg.redirectUrl})`);
    openBrowser(url);
  };

  const provider = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, onAuthorize);
  const newTransport = () =>
    new StreamableHTTPClientTransport(new URL(cfg.mcpServerUrl), { authProvider: provider });

  let client = new Client({ name: "reel-estate-mcp-bridge", version: "0.3.0" });
  const transport = newTransport();

  try {
    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // The transport has opened the browser via onAuthorize. Wait for the
      // redirect, exchange the code, then reconnect with the fresh token.
      if (!ref.callback) {
        throw new Error("Authorization required but no authorization URL was produced by the provider.");
      }
      const code = await ref.callback.waitForCode;
      await transport.finishAuth(code); // exchanges the code and persists the token
      // The first transport is already started (and the client already bound to
      // it), so a second connect() throws "already started". Reconnect with fresh
      // instances — the token finishAuth just cached makes this succeed silently.
      client = new Client({ name: "reel-estate-mcp-bridge", version: "0.3.0" });
      await client.connect(newTransport());
    }
  } finally {
    ref.callback?.close();
  }

  console.error(`[reel-estate-mcp] connected to ${cfg.mcpServerUrl}`);
  return client;
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
 * session (tokens + PKCE verifier), and drop the in-memory connection so the
 * next tool call re-authorizes via the browser. The DCR client registration is
 * kept (app-level, not per-user).
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
