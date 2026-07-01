import { callTool, close as closeUpstream } from "../src/upstream.js";

/**
 * OAuth diagnostic. Instruments global fetch so every /oauth/* and /.well-known/*
 * request + response is printed, then drives the REAL upstream connection
 * (upstream.ts) by calling the `whoami` tool. Run `npm run diag`, approve the
 * browser, and share the [diag] lines.
 */

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const interesting = /\/oauth\/|\/\.well-known\//.test(url);
  if (interesting) {
    console.error(`\n[diag] → ${init?.method ?? "GET"} ${url}`);
    if (init?.body) console.error(`[diag]   body: ${String(init.body).slice(0, 600)}`);
  }
  const res = await realFetch(input as any, init);
  if (interesting) {
    const txt = await res.clone().text().catch(() => "");
    console.error(`[diag]   ← ${res.status} ${txt.slice(0, 400)}`);
  }
  return res;
}) as typeof fetch;

async function main() {
  console.error("[diag] calling whoami through the real upstream connection...");
  const who = await callTool("whoami", {});
  console.error("[diag] ✅ whoami result:");
  console.error(JSON.stringify(who, null, 2));
}

main()
  .catch((e) => {
    console.error("[diag] ❌ FAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => closeUpstream());
