# Publishing

How to release `reel-estate-mcp` to **npm** and the **MCP registry**.

The registry only indexes; the code lives on npm. So the order is always:
**npm first, registry second** (the registry validates against the live npm package).

## Prerequisites (one-time)

- An npm account with publish rights (`packages@tryreelestate.com`).
- Membership in the **TryReelEstate** GitHub org (owns the `io.github.tryreelestate/*` namespace).
- The `mcp-publisher` CLI on your PATH:
  - Windows: download from <https://github.com/modelcontextprotocol/registry/releases>
  - or: `go install github.com/modelcontextprotocol/registry/cmd/mcp-publisher@latest`
- Node.js 18+.

## Invariants

- `version` in **`package.json`** and **`server.json`** must be identical.
- `mcpName` (package.json) == `name` (server.json) == `io.github.tryreelestate/reel-estate-mcp`.
- The npm package name is `reel-estate-mcp` (unscoped, public).

## Release steps

### 1. Bump the version (both files)

Edit `version` in `package.json`, and `version` + `packages[0].version` in `server.json`
to the same new value, then sync the lockfile:

```bash
npm install --package-lock-only
```

### 2. Build + sanity check

```bash
npm ci                 # clean install from the lockfile
npm run typecheck      # tsc --noEmit
npm run build          # emits dist/ (also runs on publish via prepublishOnly)
npm pack --dry-run     # confirm tarball = dist/*, README.md, LICENSE, package.json
```

### 3. Publish to npm (first!)

```bash
npm login              # sign in as packages@tryreelestate.com
npm whoami             # confirm the right account (not a personal one)
npm publish            # prepublishOnly builds dist; publishConfig makes it public
# if the account has 2FA:
#   npm publish --otp=123456
```

Verify the live package carries the registry back-reference:

```bash
npm view reel-estate-mcp version     # your new version
npm view reel-estate-mcp mcpName     # io.github.tryreelestate/reel-estate-mcp
```

### 4. Publish to the MCP registry

```bash
mcp-publisher login github           # device-flow OAuth; TryReelEstate org membership
mcp-publisher publish                # reads ./server.json, validates mcpName vs live npm
```

Verify the listing:

```bash
curl "https://registry.modelcontextprotocol.io/v0/servers?search=reel-estate"
```

## Common trip-ups

- **Registry publish fails to find the package** — you published to the registry before npm. Do npm first.
- **Version mismatch** — `server.json` version ≠ the npm version you published. Keep them equal.
- **`mcpName` missing on npm** — the registry can't verify ownership. Ensure `package.json` has `mcpName` and re-publish to npm.
- **`$schema` rejected** — the pinned schema date in `server.json` has advanced; run `mcp-publisher init` to regenerate with the current schema, then re-apply the fields.
