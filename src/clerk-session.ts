import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { getConfig } from "./config.js";

/**
 * Authenticates as a single configured user via the Clerk Backend API and
 * hands out short-lived session tokens (JWTs) for the HTTP API client.
 *
 * Flow (proven against the live instance):
 *   1. Resolve the Clerk user id — MCP_USER may be a `user_...` id or an email
 *      (looked up via users.getUserList).
 *   2. createSession({ userId }) once per process → an active session id.
 *   3. getToken(sessionId, undefined, ttl) → a JWT the API verifies via JWKS,
 *      with `sub` = the user id. Cached until shortly before expiry.
 *
 * The session is revoked on shutdown to avoid leaving stray sessions behind.
 */

const SKEW_SECONDS = 60; // refresh this long before the token actually expires

export class ClerkSession {
  private client: ClerkClient;
  private clerkUserId: string | null = null;
  private sessionId: string | null = null;
  private token: { jwt: string; expiresAt: number } | null = null;

  constructor() {
    const { clerkSecretKey } = getConfig();
    this.client = createClerkClient({ secretKey: clerkSecretKey });
  }

  /** Resolve and cache the Clerk user id for the configured MCP_USER. */
  async resolveUserId(): Promise<string> {
    if (this.clerkUserId) return this.clerkUserId;
    const { user } = getConfig();

    if (user.startsWith("user_")) {
      this.clerkUserId = user;
      return user;
    }

    const list = await this.client.users.getUserList({ emailAddress: [user], limit: 1 });
    const found = list.data?.[0];
    if (!found) {
      throw new Error(`No Clerk user found for email "${user}".`);
    }
    this.clerkUserId = found.id;
    return found.id;
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const userId = await this.resolveUserId();
    const session = await this.client.sessions.createSession({ userId });
    this.sessionId = session.id;
    return session.id;
  }

  /** Return a valid bearer token, minting/refreshing as needed. */
  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - SKEW_SECONDS > now) {
      return this.token.jwt;
    }

    const { tokenTtlSeconds } = getConfig();
    let sessionId = await this.ensureSession();

    let tokenResource;
    try {
      tokenResource = await this.client.sessions.getToken(sessionId, undefined, tokenTtlSeconds);
    } catch (err) {
      // Session may have been revoked/expired out from under us — rebuild once.
      this.sessionId = null;
      this.token = null;
      sessionId = await this.ensureSession();
      tokenResource = await this.client.sessions.getToken(sessionId, undefined, tokenTtlSeconds);
    }

    const jwt = (tokenResource as { jwt?: string }).jwt ?? String(tokenResource);
    this.token = { jwt, expiresAt: now + tokenTtlSeconds };
    return jwt;
  }

  /** Who are we authenticated as (for diagnostics / whoami). */
  async identity(): Promise<{ clerkUserId: string; sessionId: string | null }> {
    return { clerkUserId: await this.resolveUserId(), sessionId: this.sessionId };
  }

  /** Revoke the session we created. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = null;
      this.token = null;
      try {
        await this.client.sessions.revokeSession(id);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
