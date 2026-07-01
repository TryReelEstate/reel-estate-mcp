import { callTool, close as closeUpstream } from "../src/upstream.js";

/**
 * Interactive login. Run in a terminal: `npm run login`.
 *
 * Triggers the OAuth browser flow (which a Claude-launched stdio server can't
 * reliably pop) and caches the token, then exits. After it succeeds, MCP tool
 * calls through your client authenticate silently off the cached token.
 */
async function main() {
  console.error("Authorizing… a browser window should open.");
  console.error("If it doesn't, copy the 'Open this URL to authorize' link printed below into a browser.\n");

  const who = (await callTool("whoami", {})) as { profile?: { data?: { email?: string } } };

  console.error("\n✅ Logged in — token cached at ~/.reel-estate-mcp.");
  const email = who?.profile?.data?.email;
  if (email) console.error(`   Authenticated as: ${email}`);
  console.error("   MCP tool calls will now authenticate silently. Use the `logout` tool to sign out.");
}

main()
  .catch((e) => {
    console.error("\n❌ Login failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => closeUpstream());
