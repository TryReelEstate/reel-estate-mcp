import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
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
  server.on("error", (err) => reject(err));
  server.listen(port);

  return { waitForCode, close: () => { try { server.close(); } catch { /* noop */ } } };
}

async function connect(): Promise<Client> {
  const cfg = getConfig();
  const provider = new FileOAuthProvider(cfg.oauthStoreDir, cfg.redirectUrl, cfg.scope, openBrowser);
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpServerUrl), {
    authProvider: provider,
  });
  const client = new Client({ name: "reel-estate-mcp-bridge", version: "0.3.0" });

  const callback = startCallbackServer(cfg.callbackPort);
  try {
    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // First run / expired refresh: the transport has opened the browser via
      // the provider. Wait for the redirect, exchange the code, then reconnect.
      console.error(`[reel-estate-mcp] waiting for browser authorization (callback ${cfg.redirectUrl}) ...`);
      const code = await callback.waitForCode;
      await transport.finishAuth(code);
      await client.connect(transport);
    }
  } finally {
    callback.close();
  }

  console.error(`[reel-estate-mcp] connected to ${cfg.mcpServerUrl}`);
  return client;
}

/** Lazily establish (and memoize) the upstream connection. */
export function getClient(): Promise<Client> {
  if (!clientPromise) clientPromise = connect();
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
