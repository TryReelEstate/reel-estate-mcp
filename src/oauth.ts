import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Opens the system browser to `url` so the user can authorize. Best-effort:
 * also prints the URL to stderr in case the launch fails (headless box, etc.).
 */
export function openBrowser(url: string): void {
  console.error(`\n[reel-estate-mcp] Open this URL to authorize:\n${url}\n`);
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window title arg.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* user can copy the URL from stderr */
  }
}

/**
 * Filesystem-backed OAuth client provider for a single backend `/mcp`.
 *
 * Persists three things under the store dir so re-runs don't re-authorize:
 *   - client.json   — the dynamically-registered client (DCR result)
 *   - tokens.json   — access + refresh tokens
 *   - verifier.txt  — the in-flight PKCE code verifier
 *
 * `redirectToAuthorization` just opens the browser; the loopback callback that
 * catches the `code` lives in upstream.ts (it must outlive a single call).
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly storeDir: string,
    private readonly _redirectUrl: string,
    private readonly scope: string | undefined,
    private readonly onAuthorizeUrl: (url: string) => void,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "reel-estate-mcp (self-hosted)",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client + PKCE — no client secret to distribute.
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.readJson<OAuthClientInformationFull>("client.json");
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.writeJson("client.json", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.readJson<OAuthTokens>("tokens.json");
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writeJson("tokens.json", tokens);
  }

  /**
   * Forget the current session (logout). Removes the cached tokens and any
   * in-flight PKCE verifier, so the next connect re-authorizes. Keeps the DCR
   * client registration (it's app-level, not per-user) so re-login reuses it.
   */
  async clearSession(): Promise<void> {
    await rm(join(this.storeDir, "tokens.json"), { force: true });
    await rm(join(this.storeDir, "verifier.txt"), { force: true });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.storeDir, "verifier.txt"), verifier, "utf8");
  }

  async codeVerifier(): Promise<string> {
    return readFile(join(this.storeDir, "verifier.txt"), "utf8");
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizeUrl(authorizationUrl.toString());
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.storeDir, name), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.storeDir, name), JSON.stringify(value, null, 2), "utf8");
  }
}
