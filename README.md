# reel-estate-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an
AI assistant (Claude Desktop, Claude Code, Cursor, etc.) **read-only** access to
the Reel Estate backend's MongoDB — users, projects, clips, and usage — for
support, debugging, and analytics.

> **Read-only by design.** Every tool issues `find` / `aggregate` / `count`
> only. There are no write/update/delete tools. Point it at **staging** unless
> you have a deliberate reason to inspect production.

## Tools

| Tool | What it returns |
| --- | --- |
| `find_user` | One user by **ObjectId or email** — profile, subscription, account usage. Password hash is never returned. |
| `list_projects` | A user's projects (summaries: status, address, image/clip/voiceover counts), newest-interacted first, paginated. |
| `get_project` | One project by id. The heavy `timeline` and `images` arrays are excluded unless you set `includeTimeline` / `includeImages`. |
| `list_clips` | Generated clips scoped by `user` and/or `projectId`, with status/motion/provider/credits. |
| `get_usage_summary` | One-call support dashboard: account credit/export usage + project and clip counts by status. |
| `db_overview` | Estimated document counts for core collections (connectivity/health check). |

## Setup

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI
```

`.env`:

```
MONGODB_URI=mongodb+srv://<user>:<password>@reel-estate.dumnqll.mongodb.net/reel-estate-v2?retryWrites=true&w=majority&family=4
MCP_MAX_LIMIT=100
```

The database name comes from the connection string (`reel-estate-v2` for
staging). `MCP_MAX_LIMIT` is the hard ceiling for any list tool's `limit`.

### Verify it works

```bash
npm run typecheck       # tsc, no emit
npm run smoke           # exercises every tool against the configured DB
```

`npm run smoke` defaults to the known staging example user
(`69b0b5cffc721a453860a8e6`); override with `SMOKE_USER=<id-or-email>`.

## Connecting it to a client

### Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "reel-estate": {
      "command": "npx",
      "args": ["tsx", "C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts"],
      "env": {
        "MONGODB_URI": "mongodb+srv://<user>:<password>@reel-estate.dumnqll.mongodb.net/reel-estate-v2?retryWrites=true&w=majority&family=4"
      }
    }
  }
}
```

> Putting `MONGODB_URI` in the `env` block keeps the secret out of the repo and
> out of `.env`. If you'd rather use `.env`, drop the `env` block.

### Claude Code

```bash
claude mcp add reel-estate -- npx tsx C:/Users/jgoye/Documents/GitHub/reel-estate-mcp/src/index.ts
```

### Production build (optional)

```bash
npm run build      # emits dist/
node dist/index.js # run the compiled server instead of tsx
```

## Example calls

These use the real staging example user **Jeff Goyette**
(`jeff@tryreelestate.com`, id `69b0b5cffc721a453860a8e6`).

**`find_user`** — either form works:

```jsonc
{ "user": "jeff@tryreelestate.com" }
// or
{ "user": "69b0b5cffc721a453860a8e6" }
```

```jsonc
{
  "found": true,
  "_id": "69b0b5cffc721a453860a8e6",
  "email": "jeff@tryreelestate.com",
  "name": "Jeff Goyette",
  "role": "admin",
  "subscription": { "status": "active", "plan": "pro", "cancelAtPeriodEnd": false },
  "usage": { "creditsUsed": 1327, "creditsLimit": 1328, "videosGenerated": 571, "...": "..." }
}
```

**`get_usage_summary`** — `{ "user": "jeff@tryreelestate.com" }`:

```jsonc
{
  "subscription": { "plan": "pro", "status": "active" },
  "projects": { "total": 146, "byStatus": { "completed": { "count": 77 }, "draft": { "count": 69 } } },
  "clips":    { "total": 530, "byStatus": { "completed": { "count": 530, "creditsUsed": 1335 } } }
}
```

**`list_projects`** — `{ "user": "jeff@tryreelestate.com", "status": "completed", "limit": 5 }`

**`list_clips`** — scope by user, project, or both:

```jsonc
{ "user": "jeff@tryreelestate.com", "status": "failed", "limit": 10 }
{ "projectId": "6a35cac1611fbf84123fb5b8" }
```

**`get_project`** — summary by default; opt into heavy arrays:

```jsonc
{ "projectId": "6a3df4036903c42f9daaf089" }                         // no timeline/images
{ "projectId": "6a3df4036903c42f9daaf089", "includeImages": true }  // + images[] with vision data
```

## Architecture notes

- **`src/db.ts`** — one lazily-connected, pooled `MongoClient` shared across
  tool calls; `userFilterFrom()` accepts an ObjectId hex or an email.
- **`src/tools.ts`** — the query layer as plain async functions (so the smoke
  test calls them directly, no transport needed). List tools use aggregation
  with `$size` so they return array *counts* without transferring multi-MB
  `timeline` / `images` blobs.
- **`src/index.ts`** — registers each function as an MCP tool over **stdio**.
  Because stdio is the transport, all diagnostics go to **stderr** — stdout
  carries only MCP protocol frames.
- Soft deletes: `list_projects` excludes `deletedAt != null` by default
  (`includeDeleted: true` to override), mirroring the backend's query hooks.

## Adding a tool

1. Write a `async function fooBar(db, args)` in `src/tools.ts` returning a plain
   object.
2. Register it in `src/index.ts` with `server.registerTool(...)` and a Zod
   `inputSchema`.
3. Add a line to `scripts/smoke.ts` to cover it.

Keep new tools read-only unless there's a deliberate decision (and guardrails)
to allow writes.
