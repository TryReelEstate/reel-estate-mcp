# reel-estate-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that
authenticates as a Reel Estate **user via Clerk** and calls the backend's
**HTTP API** as that user. Give an assistant (Claude Desktop, Claude Code,
Cursor) the ability to drive the real product API — list projects, inspect
clips, check usage, hit any endpoint — exactly as the signed-in user could.

> It talks to the deployed API over HTTP; it does **not** touch the database
> directly. Auth is a genuine Clerk session token, so the API's own
> authorization rules apply.

## How auth works

```
MCP_USER (email or user_… id)
   │  Clerk Backend API (CLERK_SECRET_KEY)
   ▼
resolve Clerk user id  ──►  createSession({ userId })  ──►  getToken() → JWT
                                                              │
                          Authorization: Bearer <JWT>  ◄──────┘
                                   │
                                   ▼
                       https://<api-host>/api/v1/...
```

The server mints a session token (cached, auto-refreshed before expiry) and
sends it as a bearer token on every request. The session is revoked on
shutdown.

### ⚠️ Clerk instance must match the API environment

A Clerk session token is only accepted by an API that trusts the **same Clerk
instance**. Pair them correctly or the API returns `401 INVALID_TOKEN` even
though the token minted fine:

| API target | Clerk keys |
| --- | --- |
| Production backend | **live** (`sk_live_…`) |
| Staging / localhost backend | **test** (`sk_test_…`) |

### ⚠️ `API_BASE_URL` is the *backend* host, not the website

`https://tryreelestate.com` is the Next.js **frontend** — its `/api/v1/*` paths
404 with an HTML page. Point `API_BASE_URL` at the **backend** host (the same
URL the frontend uses as `NEXT_PUBLIC_API_URL`), e.g. your Heroku/Render app
URL or an `api.`/`server.` subdomain. Confirm with:

```bash
curl https://<api-host>/health      # → {"status":"ok","environment":"staging",...}
```

## Tools

| Tool | Endpoint |
| --- | --- |
| `whoami` | `GET /users/profile` + identity/config — **run this first** to confirm auth |
| `list_projects` | `GET /projects` (paging, sort, search, status) |
| `get_project` | `GET /projects/:id` |
| `project_stats` | `GET /projects/stats` |
| `list_clips` | `GET /clips` or `GET /clips/project/:projectId` |
| `list_movies` | `GET /movies` or `GET /movies/project/:projectId` |
| `list_voices` | `GET /voices` |
| `get_usage` | `GET /billing/usage` |
| `list_endpoints` | the curated API catalog (so you know what `api_request` can call) |
| `api_request` | **any** route, any method — the escape hatch that covers the whole API |

`api_request` is the workhorse: `{ method, path, query?, body? }`. Convenience
tools are just typed shortcuts over common endpoints.

## Setup

```bash
npm install
cp .env.example .env   # fill in CLERK_SECRET_KEY, MCP_USER, API_BASE_URL
npm run typecheck
npm run smoke          # authenticates and calls a few GET endpoints
```

`.env`:

```
CLERK_SECRET_KEY=sk_test_********           # MUST match API_BASE_URL's environment
MCP_USER=jeff@tryreelestate.com             # email or user_… id
API_BASE_URL=https://<backend-host>         # bare origin → "/api/v1" appended
MCP_TOKEN_TTL_SECONDS=3600                  # optional
MCP_READONLY=                               # optional: 1/true blocks non-GET
```

## Connecting to a client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "reel-estate": {
      "command": "npx",
      "args": ["tsx", "C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts"],
      "env": {
        "CLERK_SECRET_KEY": "sk_test_********",
        "MCP_USER": "jeff@tryreelestate.com",
        "API_BASE_URL": "https://<backend-host>"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add reel-estate \
  -e CLERK_SECRET_KEY=sk_test_******** \
  -e MCP_USER=jeff@tryreelestate.com \
  -e API_BASE_URL=https://<backend-host> \
  -- npx tsx C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts
```

## Example calls

```jsonc
// whoami  → confirm we're authenticated as the right user
{}

// list_projects
{ "limit": 5, "status": "completed", "sortBy": "updatedAt", "sortOrder": "desc" }

// api_request — anything not covered by a convenience tool
{ "method": "GET",  "path": "/billing/can-generate" }
{ "method": "POST", "path": "/staging/switch-plan", "body": { "plan": "pro" } }
{ "method": "GET",  "path": "/admin/stats" }          // requires role=admin
```

## Read-only mode

Set `MCP_READONLY=1` to block every non-GET request at the client layer — a
safety belt when pointing at production. Default is full access (all methods).

## Architecture

- **`src/config.ts`** — validated env; normalizes `API_BASE_URL` (appends
  `/api/v1`), reads the read-only flag and token TTL.
- **`src/clerk-session.ts`** — resolves the Clerk user, creates a session, and
  mints/caches/refreshes bearer tokens; revokes the session on shutdown.
- **`src/api-client.ts`** — authed `fetch` wrapper; never throws on non-2xx so
  the model sees the API's error envelope; enforces the read-only guard.
- **`src/catalog.ts`** — the endpoint catalog surfaced by `list_endpoints`.
- **`src/tools.ts`** — tools as plain functions (smoke-testable without a
  transport).
- **`src/index.ts`** — registers the tools as MCP tools over **stdio**
  (diagnostics → stderr, protocol → stdout).

## Adding a tool

1. Add `async function fooBar(api, args)` in `src/tools.ts` (use `api.get(...)`
   or `api.request(...)`).
2. Register it in `src/index.ts` with a Zod `inputSchema`.
3. Add it to `scripts/smoke.ts` if it's a GET.

Everything is already reachable through `api_request`; convenience tools just
make the common paths first-class.
