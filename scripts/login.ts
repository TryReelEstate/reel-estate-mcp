import { login, close as closeUpstream } from "../src/upstream.js";

/**
 * Interactive login. Run in a terminal: `npm run login`.
 *
 * Triggers the OAuth browser flow, waits for you to approve, caches the token,
 * then exits. After it succeeds, MCP tool calls through your client
 * authenticate silently off the cached token.
 */
async function main() {
  const result = await login();

  if (result.status === "authenticated") {
    console.error(`✅ ${result.message}`);
    return;
  }

  console.error("A browser should have opened. If not, open this URL to authorize:\n");
  console.error(`  ${result.authorizeUrl}\n`);
  console.error("Waiting for you to approve the sign-in…");

  await result.completion; // resolves once the redirect is caught and the token is cached

  console.error("\n✅ Logged in — token cached at ~/.reel-estate-mcp.");
  console.error("   MCP tool calls will now authenticate silently. Use the `logout` tool to sign out.");
}

main()
  .catch((e) => {
    console.error("\n❌ Login failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => closeUpstream());
