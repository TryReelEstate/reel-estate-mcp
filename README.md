# reel-estate-mcp

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server
that gives an assistant (Claude Desktop, Claude Code, Cursor) the Reel Estate
product API **plus local-filesystem superpowers** — most notably uploading
**local image files** into a project.

It is an **OAuth client of the backend's embedded `/mcp` endpoint**. It does
**not** mint Clerk sessions and needs **no secret key**: you sign in through
your browser once, tokens are cached locally, and every API call is proxied
through `/mcp` (the backend stays the single auth authority). The only thing
this server adds is the ability to read local files and stream their bytes
straight to storage — something a remote MCP can't do.

## How auth works

```
first tool call
   │   StreamableHTTP client ──► backend /mcp  (401, needs auth)
   ▼
opens your browser ──► Clerk OAuth (DCR + PKCE) ──► you approve
   │                                                   │
   ▼                                                   ▼
loopback http://localhost:8765/callback?code=…   access + refresh tokens
   │                                                   │
   └────────────► finishAuth(code) ──► tokens cached ──┘
                                       (~/.reel-estate-mcp)

every later call:  callTool("api_request", …) over the authed /mcp connection
```

- **No secrets to distribute** — public client + PKCE, browser login per user.
- **Prod-capable** — uses the same OAuth the backend already serves at `/mcp`
  (unlike server-side Clerk session minting, which only works on dev instances).
- **Re-authorize / switch user** — delete the token cache dir and run again.

### `MCP_SERVER_URL` is the *backend* origin, not the website

`/mcp` is mounted on the **backend** host (the same origin the frontend uses as
its API base), e.g. your Heroku/Render app URL — not the marketing site. A bare
origin gets `/mcp` appended automatically.

## Tools

| Tool | Endpoint |
| --- | --- |
| `whoami` | `GET /users/profile` + config — **run this first**; first call opens the browser to authorize |
| `list_projects` | `GET /projects` (paging, sort, search, status) |
| `get_project` | `GET /projects/:id` |
| `project_stats` | `GET /projects/stats` |
| `list_clips` | `GET /clips` or `GET /clips/project/:projectId` |
| `list_movies` | `GET /movies` or `GET /movies/project/:projectId` |
| `list_voices` | `GET /voices` |
| `resolve_address` | geocode a free-text address → ranked candidates (for creating real-listing projects) |
| `add_image_from_file` | upload a **local** image file to a project — presigned `PUT` to storage, then attach (no storage creds) |
| `generate_clip` | animate a project image into a video clip (Runway); returns a jobId |
| `get_clip_status` | poll a `generate_clip` job |
| `edit_image` | Gemini image edit (staging / twilight / upscale / seasonal / replace-remove-add / manual); versioned |
| `render_movie` | assemble the project timeline into the final movie |
| `list_endpoints` | the curated API catalog (so you know what `api_request` can call) |
| `api_request` | **any** route, any method — the escape hatch that covers the whole API |

All API tools are proxied through the backend's `/mcp` `api_request` tool, so
the backend's own authorization rules apply. `api_request` is the workhorse:
`{ method, path, query?, body? }`.

## Setup

```bash
npm install
cp .env.example .env   # set MCP_SERVER_URL (the backend origin hosting /mcp)
npm run typecheck
npm run smoke          # opens a browser to authorize, then calls a few GETs
```

`.env`:

```
MCP_SERVER_URL=https://<backend-host>   # bare origin → "/mcp" appended
MCP_OAUTH_CALLBACK_PORT=8765            # optional; loopback port for the redirect
MCP_OAUTH_STORE_DIR=                    # optional; default ~/.reel-estate-mcp
MCP_OAUTH_SCOPE=                        # optional; negotiated from metadata if blank
MCP_READONLY=                           # optional: 1/true blocks non-GET
```

> The backend must have **Dynamic Client Registration** enabled in its Clerk
> dashboard for first-time OAuth to register this client automatically.

## Connecting to a client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "reel-estate": {
      "command": "npx",
      "args": ["tsx", "C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts"],
      "env": {
        "MCP_SERVER_URL": "https://<backend-host>"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add reel-estate \
  -e MCP_SERVER_URL=https://<backend-host> \
  -- npx tsx C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts
```

The first tool call opens your browser to authorize. If the browser can't open
(headless box), copy the URL printed to stderr.

## Example calls

```jsonc
// whoami  → first call authorizes via the browser, then confirms the user
{}

// add_image_from_file  → upload a LOCAL photo into a project
{ "projectId": "6a4444cb7cd177ef1136daa1", "path": "C:/photos/exterior.jpg", "caption": "Front exterior" }

// api_request — anything not covered by a convenience tool
{ "method": "GET",  "path": "/billing/can-generate" }
{ "method": "POST", "path": "/projects", "body": { "name": "123 Main St" } }
```

## Read-only mode

Set `MCP_READONLY=1` to block every non-GET request at this layer — a safety
belt when pointing at production. Default is full access (all methods).

## Architecture

- **`src/config.ts`** — validated env; derives the `/mcp` URL, OAuth store dir,
  loopback callback port, read-only flag.
- **`src/oauth.ts`** — `OAuthClientProvider`: caches the DCR client + tokens +
  PKCE verifier on disk; opens the system browser to authorize.
- **`src/upstream.ts`** — the single OAuth'd MCP client connection to `/mcp`
  (with the loopback callback server); `callTool` / `callApiRequest` proxies.
- **`src/api-client.ts`** — `ApiClient` over `callApiRequest`; same
  `{ status, ok, url, method, data }` shape as before, enforces read-only.
- **`src/catalog.ts`** — the endpoint catalog surfaced by `list_endpoints`.
- **`src/tools.ts`** — tools as plain functions (smoke-testable). `add_image_from_file`
  reads a local file → mints a presigned URL → `PUT`s bytes → attaches.
- **`src/index.ts`** — registers the tools as MCP tools over **stdio**
  (diagnostics → stderr, protocol → stdout).

## Adding a tool

1. Add `async function fooBar(api, args)` in `src/tools.ts` (use `api.get(...)`
   or `api.request(...)`, which proxy through `/mcp`).
2. Register it in `src/index.ts` with a Zod `inputSchema`.
3. Add it to `scripts/smoke.ts` if it's a GET.

Everything is already reachable through `api_request`; convenience tools just
make the common paths first-class.
