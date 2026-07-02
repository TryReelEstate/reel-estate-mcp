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

```bash
git clone https://github.com/TryReelEstate/reel-estate-mcp.git
cd reel-estate-mcp
npm install
```

That's it — the server runs straight from TypeScript via `tsx`; no build step.

## Connect your assistant

**Zero config for production** — the bridge defaults to the Reel Estate production
backend (`https://api.tryreelestate.com`) and bundles the matching public OAuth
`client_id`, so you just point your client at the cloned `src/index.ts`. Only set
`MCP_SERVER_URL` for **staging** or a **self-hosted** backend.

### Claude Code

```bash
claude mcp add reel-estate -- npx tsx /path/to/reel-estate-mcp/src/index.ts
```

For staging / self-hosted, pass the backend origin (`/mcp` is appended):

```bash
claude mcp add reel-estate \
  -e MCP_SERVER_URL=https://your-backend.example.com \
  -- npx tsx /path/to/reel-estate-mcp/src/index.ts
```

### Claude Desktop / Cursor

Add to your client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`),
fixing the path to your clone:

```json
{
  "mcpServers": {
    "reel-estate": {
      "command": "npx",
      "args": ["tsx", "/path/to/reel-estate-mcp/src/index.ts"]
    }
  }
}
```

> For staging or a self-hosted backend, add an `"env"` block with
> `"MCP_SERVER_URL": "https://your-backend.example.com"` (and, for a backend on a
> different Clerk instance, `"MCP_OAUTH_CLIENT_ID"`).

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

## Configuration

Set env vars in your client's MCP config (recommended) or in a local `.env`
(loaded from this package's folder). **All are optional** — the defaults target
Reel Estate production.

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_SERVER_URL` | `https://api.tryreelestate.com` | Reel Estate backend origin (the API host); `/mcp` is appended. Set for staging or a self-hosted backend. |
| `MCP_OAUTH_CLIENT_ID` | bundled per host | Public OAuth client id. Defaults are bundled for Reel Estate's production and staging backends. **Set it only** for a backend on a different Clerk instance (e.g. self-hosted) — a client id is valid only on the instance that created it. |
| `MCP_OAUTH_CALLBACK_PORT` | `8765` | Loopback port for the OAuth redirect; must match the registered redirect URI (`http://localhost:<port>/callback`). |
| `MCP_OAUTH_STORE_DIR` | `~/.reel-estate-mcp` | Where OAuth tokens are cached. |
| `MCP_OAUTH_SCOPE` | negotiated | Override the OAuth scope. |
| `MCP_READONLY` | off | `1`/`true` blocks all non-GET requests (a safety belt against writes). |

> **Authentication is public OAuth + PKCE.** There is no client secret and no API
> key. Dynamic Client Registration is **not** used — the bridge presents the
> pre-registered public client (the bundled default, or your `MCP_OAUTH_CLIENT_ID`).

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
| No login prompt / "not authenticated" | Run any tool (or `login`), open the printed URL, and approve. To re-auth or switch users: `rm -rf ~/.reel-estate-mcp`. |
| `invalid_client` on login | `MCP_OAUTH_CLIENT_ID` doesn't match the backend's Clerk instance. Use the client id registered on the instance behind your `MCP_SERVER_URL`. |
| Browser login never completes | Ensure the Clerk OAuth client has `http://localhost:8765/callback` registered as a redirect URI (match `MCP_OAUTH_CALLBACK_PORT`). |
| `does not support dynamic client registration` | The backend has DCR disabled — set `MCP_OAUTH_CLIENT_ID` (or use the bundled default). |

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
