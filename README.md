# reel-estate-mcp

**Turn real-estate listing photos into cinematic property videos from your AI
assistant.** `reel-estate-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that connects **Claude, Cursor, and other AI assistants** to your
[**Reel Estate**](https://tryreelestate.com) account — so you can generate motion
clips, AI-edit photos (virtual staging, twilight, seasonal), add voiceover, and
render finished listing videos, all in plain language.

> Reel Estate is the AI real-estate video platform that turns property photos into
> scroll-stopping listing videos. Create a free account at
> **[tryreelestate.com](https://tryreelestate.com)**.

You sign in once through your browser (OAuth + PKCE — **no API keys, no secrets**),
and every call is proxied through the backend's `/mcp` endpoint, which stays the
single authority for auth, plans, and permissions. This bridge's one superpower on
top of that: it can read **local image files** and stream them straight into a
project — something a purely remote server can't do.

- 🎬 **Generate real-estate videos** — animate photos into clips, then render the movie
- 🖼️ **AI photo editing** — virtual staging, twilight, upscale, seasonal, replace/remove/add
- 🎙️ **Voiceover & timeline** — narration, music, overlays, reordering
- 📤 **Local uploads** — push photos from disk into a project
- 🔐 **Browser sign-in** — public OAuth client + PKCE; nothing secret stored
- 🤖 **Works with** Claude Code, Claude Desktop, and Cursor

## Requirements

- **Node.js 18+**
- A **[Reel Estate](https://tryreelestate.com) account** (a **paid plan** is
  required to create/generate/render; free accounts are read-only over the MCP)
- An MCP-compatible client: **Claude Code**, **Claude Desktop**, or **Cursor**

## Install

Nothing to clone or build — your MCP client launches it on demand via `npx`. You
only need **Node.js ≥ 18**. (Prefer a global command? `npm install -g reel-estate-mcp`,
then use `reel-estate-mcp` in place of `npx -y reel-estate-mcp` below.)

## Connect your assistant

**Zero config** — the bridge connects to Reel Estate and handles browser sign-in
for you. There's nothing to set up.

### Claude Code

```bash
claude mcp add reel-estate -- npx -y reel-estate-mcp
```

### Claude Desktop / Cursor

Add to your client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "reel-estate": {
      "command": "npx",
      "args": ["-y", "reel-estate-mcp"]
    }
  }
}
```

## First run — sign in

The first tool call opens your browser to sign in with your Reel Estate account
(Clerk OAuth, authorization code + PKCE). After you approve, the browser returns to
`http://localhost:8765/callback`, tokens cache under `~/.reel-estate-mcp`, and
you're in — you won't log in again until the token expires.

Start with **`whoami`** to confirm auth and see your plan, then just ask:

- *"List my recent projects."*
- *"Create a project for 123 Main St and upload the photos in ./listing."*
- *"Virtually stage the living room photo, generate a drone clip, then render in 9:16."*
- *"How many credits and exports do I have left?"*

To switch users or re-authorize, run **`logout`** (revokes server-side + clears
the cache) or delete `~/.reel-estate-mcp`.

## Tools

All API tools proxy through the backend's `/mcp` `api_request`, so the backend's
own authorization and plan rules apply.

| Tool | What it does |
| --- | --- |
| `help` | Guided, always-current walkthrough (also the `getting_started` prompt) |
| `whoami` | Confirm auth; reports `plan`, `canWrite`, and a `writeAccess` reason. **Run first.** |
| `login` / `logout` | Start browser sign-in / clear the session (server revoke + local cache) |
| `list_projects` · `get_project` · `project_stats` | Browse projects |
| `list_clips` · `list_movies` · `list_voices` | Browse clips, rendered movies, TTS voices |
| `resolve_address` | Geocode a free-text address → ranked candidates (for real-listing projects) |
| `add_image_from_file` | Upload a **local** image into a project (presigned upload — no storage creds) |
| `generate_clip` · `get_clip_status` | Animate a photo into a video clip (Runway); poll the job |
| `edit_image` | AI photo edit — virtual staging, twilight, upscale, seasonal, replace/remove/add, manual |
| `add_timeline_audio` · `add_timeline_overlay` | Place voiceover/music/audio or an image/text overlay |
| `move_timeline_element` · `reorder_timeline` | Retime / resequence the timeline |
| `render_movie` | Assemble the timeline into the final listing video |
| `list_endpoints` · `api_request` | Discover the API catalog / call any route — the escape hatch |

### Paid vs free

Writes and generation over the MCP require a **paid plan** — free accounts are
**read-only** (browse projects, clips, and movies). `whoami` reports this up front;
a blocked write returns `403 MCP_PAID_PLAN_REQUIRED`. See plans at
[tryreelestate.com](https://tryreelestate.com).

## How auth works

```
first tool call
   │   StreamableHTTP client ──► backend /mcp  (401, needs auth)
   ▼
opens your browser ──► Clerk OAuth (authorization code + PKCE, public client)
   │                                                   │
   ▼                                                   ▼
loopback http://localhost:8765/callback?code=…   access + refresh tokens
   │                                                   │
   └────────────► finishAuth(code) ──► tokens cached ──┘  (~/.reel-estate-mcp)

every later call:  callTool("api_request", …) over the authed /mcp connection
```

- **No secrets to distribute** — public client + PKCE, browser login per user.
- **Prod-capable** — uses the same OAuth the backend serves at `/mcp`.
- **The backend is the single auth authority** — this bridge never mints tokens.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No login prompt / "not authenticated" | Run any tool (or `login`), open the printed URL, and approve. |
| Switch accounts / re-authorize | Run `logout`, or delete `~/.reel-estate-mcp`. |
| Writes blocked (`403 MCP_PAID_PLAN_REQUIRED`) | Creating/generating/rendering needs a paid plan; free accounts are read-only. See [tryreelestate.com](https://tryreelestate.com). |

## Architecture

- **`src/config.ts`** — validated env (loaded from this package's folder); derives
  the `/mcp` URL, OAuth store dir, callback port, read-only flag, and default client id.
- **`src/oauth.ts`** — `OAuthClientProvider`: uses the public `client_id`, caches
  tokens + the PKCE verifier, opens the system browser.
- **`src/upstream.ts`** — the single OAuth'd MCP client connection to `/mcp` (with
  the loopback callback server); `callTool` / `callApiRequest` proxies.
- **`src/api-client.ts`** — `ApiClient` over `callApiRequest`; enforces read-only.
- **`src/catalog.ts`** — the endpoint catalog surfaced by `list_endpoints`.
- **`src/tools.ts`** — tools as plain functions (smoke-testable).
- **`src/index.ts`** — registers the tools as MCP tools over **stdio**.

### Adding a tool

1. Add `async function fooBar(api, args)` in `src/tools.ts` (use `api.get(...)` /
   `api.request(...)`, which proxy through `/mcp`).
2. Register it in `src/index.ts` with a Zod `inputSchema`.
3. Add it to `scripts/smoke.ts` if it's a GET.

Everything is already reachable through `api_request`; convenience tools just make
the common paths first-class.

## About Reel Estate

[**Reel Estate**](https://tryreelestate.com) helps real-estate agents and marketers
turn ordinary **listing photos into professional property videos** — AI virtual
staging, twilight conversion, motion/drone clips, voiceover narration, and one-click
rendering for Instagram, TikTok, and YouTube. This MCP server brings that workflow
into your AI assistant. **[Get started at tryreelestate.com →](https://tryreelestate.com)**

---

*Keywords: real estate video generator, AI listing video, virtual staging, MCP
server, Model Context Protocol, Claude, Cursor, property video marketing, drone
real estate video, twilight photo editing.*
