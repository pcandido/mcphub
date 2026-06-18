# GMCP — MCP Gateway Design Spec

**Date:** 2026-06-17  
**Status:** Draft

## Overview

GMCP is an MCP (Model Context Protocol) gateway that aggregates multiple upstream MCP servers behind a single stdio interface. It supports both stdio-based and HTTP SSE-based MCPs (with OAuth), stores configuration in `~/.gmcp.json`, and keeps OAuth secrets in the OS secure keychain. A companion CLI manages server registration, testing, and status.

**Target platforms:** macOS and Linux  
**Runtime:** Node.js 20+ (zero external dependencies)  
**Distribution:** npm package `gmcp`

---

## Architecture

Two modes of operation in one binary:

| Mode | Command | Description |
|---|---|---|
| CLI | `gmcp <subcommand>` | Manage servers in `~/.gmcp.json` |
| Gateway | `gmcp serve` | Run as MCP stdio server, aggregate upstreams |

The gateway reads `~/.gmcp.json` on startup, connects to all enabled upstream MCP servers (applying allow/block lists), calls `initialize` and `tools/list` on each, prefixes every tool with the server name (`server__tool`), and merges into a single consolidated tool list presented to the client.

---

## Config File: `~/.gmcp.json`

```json
{
  "version": 1,
  "servers": {
    "github": {
      "type": "stdio",
      "enabled": true,
      "description": "GitHub MCP server",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    "jira": {
      "type": "sse",
      "enabled": true,
      "description": "Jira via MCP gateway",
      "url": "https://mcp.jira.example.com/sse",
      "headers": {
        "X-Custom-Header": "value"
      },
      "oauth": true
    }
  }
}
```

**Rules:**
- `version` is required (future schema migrations)
- `enabled: false` means the gateway skips this server on startup
- `env` and `headers` are stored inline — plaintext in the config file
- `"oauth": true` means all OAuth details (URLs, client_id, scopes, tokens) live **exclusively** in the OS keychain, keyed by server name

### Server Types

**stdio:**
- `command`: executable path or name
- `args`: array of string arguments
- `env`: optional environment variables

**sse:**
- `url`: full URL to the MCP SSE endpoint
- `headers`: optional HTTP headers
- `oauth`: boolean flag — if true, OAuth credentials come from keychain

---

## Keychain Abstraction

OAuth secrets are stored as JSON blobs in the OS keychain, one entry per server.

**macOS:** Uses `/usr/bin/security` CLI
- `security add-generic-password -a gmcp -s <serverName> -w <json>`
- `security find-generic-password -a gmcp -s <serverName> -w`
- `security delete-generic-password -a gmcp -s <serverName>`

**Linux:** Uses `secret-tool` (libsecret-tools package)
- `secret-tool store --label='gmcp' server <serverName>`
- `secret-tool lookup server <serverName>`
- `secret-tool clear server <serverName>`

**Interface:**

```typescript
interface Keychain {
  get(serverName: string): Promise<OAuthSecret | null>;
  set(serverName: string, secret: OAuthSecret): Promise<void>;
  delete(serverName: string): Promise<void>;
}
```

**OAuthSecret format (stored in keychain):**

```json
{
  "authorization_url": "https://auth.example.com/authorize",
  "token_url": "https://auth.example.com/token",
  "client_id": "your-client-id",
  "scopes": ["read:things"],
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_at": "2026-06-17T12:00:00Z"
}
```

Backend is selected at runtime based on `process.platform`. If the keychain tool is unavailable, an error is raised with installation instructions.

---

## CLI Interface

```
gmcp add    <name>    Add or update an MCP server
gmcp remove <name>    Remove a server
gmcp get    <name>    Show a server's config (without secrets)
gmcp list             List all servers with status
gmcp test   <name>    Test connection: authenticate, list tools, return 0/1
gmcp enable <name>    Enable a server
gmcp disable <name>   Disable a server
gmcp serve            Start the MCP gateway in stdio mode
```

### `gmcp add <name>`

**Interactive mode** (default — guides the user):

```
$ gmcp add jira
Server type? [stdio/sse]: sse
Server URL: https://mcp.jira.example.com/sse
Description (optional): Jira MCP
OAuth required? [y/N]: y
  → Discovering OAuth metadata from /.well-known/oauth-protected-resource... OK
  → Opening browser for authorization...
  → Authorization complete. Token saved to keychain.
Server "jira" added.
```

If the server already exists, updates it (asks whether to re-authenticate OAuth).

**Non-interactive flags:**

```
gmcp add <name> --type sse --url https://...           \
                [--oauth]                                \
                [--oauth-auth-url ...]                   \
                [--oauth-token-url ...]                   \
                [--oauth-client-id ...]                   \
                [--oauth-scopes scope1,scope2]            \
                [--description "..."]

gmcp add <name> --type stdio --command npx --args "-y,server" \
                [--env KEY=value ...] [--description "..."]
```

### `gmcp remove <name>`

Deletes the server entry from `~/.gmcp.json`. If the server had OAuth, also removes its keychain entry.

### `gmcp get <name>`

Prints the full configuration for a server (from `~/.gmcp.json`). Does **not** print secrets from keychain. Indicates whether OAuth is configured and token validity status.

### `gmcp list`

```
$ gmcp list
  github   stdio  ✅ enabled   GitHub MCP server
  jira     sse    ✅ enabled   Jira MCP
  slack    sse    ❌ disabled  Slack MCP
```

### `gmcp test <name>`

```
$ gmcp test jira
Connecting to jira (sse: https://mcp.jira.example.com/sse)...
Authenticating... OK (token valid, expires in 45m)
Listing tools...
  1. search_jira_issues     Search Jira issues using JQL
  2. get_jira_issue         Get a specific Jira issue
  3. create_jira_issue      Create a new Jira issue
  4. list_jira_projects     List visible Jira projects
✅ 4 tools available — server is healthy.
```

**Exit codes:** `0` for success, `1` for failure (auth failure, connection refused, etc.).

If authentication fails (including refresh failure), reports error and exits with code `1` — does **not** attempt interactive re-authentication. The user must run `gmcp add` again.

### `gmcp enable <name>` / `gmcp disable <name>`

Sets `enabled` to `true` / `false` in `~/.gmcp.json` for the given server.

---

## Gateway Runtime

### Startup (`gmcp serve`)

1. Read `~/.gmcp.json`
2. Filter to `enabled: true` servers
3. Apply `GMCP_ALLOW_LIST` / `GMCP_BLOCK_LIST` environment variables
4. Connect to all upstreams in parallel:
   - **stdio:** spawn process, pipe stdin/stdout, exchange JSON-RPC
   - **sse:** HTTP connect, if `oauth: true` read keychain and refresh token if needed
5. Call `initialize` and `tools/list` on each upstream (in parallel)
6. Prefix every tool: `<serverName>__<toolName>` (always, no exceptions)
7. Apply allow/block list filters
8. Present consolidated tool list in `initialize` response

### `tools/call`

1. Extract server prefix from tool name (split on `__`)
2. Look up upstream client
3. Strip prefix to get original tool name
4. Forward the call to the correct upstream
5. Return the result

### Notifications

Forward `notifications/resources/list_changed` and similar from each upstream to the client.

### Shutdown

On `SIGTERM` or stdin close: kill all stdio processes, close all SSE connections.

---

## Filtering: GMCP_ALLOW_LIST / GMCP_BLOCK_LIST

Environment variables that control which tools are exposed.

### Allow list

```
GMCP_ALLOW_LIST=github__search,github__create_pr,jira__*
```

If set, **only** matching tools pass. Supports trailing `*` wildcard.

### Block list

```
GMCP_BLOCK_LIST=github__delete_repo,jira__admin*
```

If set, all tools **except** matching patterns pass. Supports trailing `*` wildcard.

### Both present

If **both** are set: allow list selects a subset first, then block list removes from that subset.

```
GMCP_ALLOW_LIST=jira__*
GMCP_BLOCK_LIST=jira__admin_delete
```

→ All `jira__*` tools pass, except `jira__admin_delete`.

### Neither present

All tools pass through.

---

## OAuth Engine

### Discovery

On `gmcp add` with `--oauth` (or interactive confirmation):

1. `GET https://<host>/.well-known/oauth-protected-resource`
   - Response: `{ "authorization_server": "https://auth.example.com", "resource": "..." }`
2. `GET https://auth.example.com/.well-known/oauth-authorization-server`
   - Extract: `authorization_endpoint`, `token_endpoint`, `scopes_supported`, `registration_endpoint` (optional)

If discovery fails, fall back to CLI prompts or flags for manual entry.

### Client Registration

If `registration_endpoint` is available in discovery metadata, register dynamically to obtain `client_id`. Otherwise, the user must provide `--oauth-client-id`.

### Authorization Code Flow + PKCE

1. Generate `code_verifier` (SHA-256, base64url, 32 random bytes) and `code_challenge` (S256)
2. Open browser with: `authorization_url?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256&redirect_uri=http://localhost:<random_port>&scope=...&state=<random>`
3. Start local HTTP server on random port to receive callback
4. On callback: validate `state`, receive `code`, close local server
5. POST to `token_url` with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`
6. Receive `access_token`, `refresh_token`, `expires_in`
7. Save full OAuth secret JSON to keychain

### Token Refresh (runtime)

On every call in the gateway:
- Check `expires_at` with 30s margin
- If expired: POST to `token_url` with `grant_type=refresh_token` and `refresh_token`
- Update keychain with new tokens
- If refresh fails: return error to caller (user must re-authenticate via `gmcp add`)

---

## Code Structure

```
gmcp/
├── package.json
├── bin/
│   └── gmcp.js              # CLI entry point (shebang)
├── src/
│   ├── cli.js                # Parse argv, dispatch subcommands
│   ├── commands/
│   │   ├── add.js            # gmcp add
│   │   ├── remove.js         # gmcp remove
│   │   ├── get.js            # gmcp get
│   │   ├── list.js           # gmcp list
│   │   ├── test.js           # gmcp test
│   │   ├── enable.js         # gmcp enable
│   │   ├── disable.js        # gmcp disable
│   │   └── serve.js          # gmcp serve
│   ├── config/
│   │   ├── loader.js         # Read ~/.gmcp.json + validate schema
│   │   └── writer.js         # Write ~/.gmcp.json (add/remove/enable/disable)
│   ├── keychain/
│   │   ├── index.js          # Detect OS, export backend
│   │   ├── mac.js            # security add-generic-password / find-generic-password
│   │   └── linux.js          # secret-tool store / lookup / clear
│   ├── mcp/
│   │   ├── protocol.js       # JSON-RPC 2.0 encode/decode/validate
│   │   ├── stdio-client.js   # Spawn + pipe stdio, send/receive JSON-RPC
│   │   ├── sse-client.js     # HTTP connect + SSE stream, send/receive JSON-RPC
│   │   └── registry.js       # Consolidate tools from all upstreams, prefix + filter
│   ├── oauth/
│   │   ├── discovery.js      # /.well-known/oauth-protected-resource + server metadata
│   │   ├── pkce.js           # code_verifier, code_challenge (SHA-256)
│   │   ├── flow.js           # Browser open + local callback server + token exchange
│   │   └── refresh.js        # Token refresh logic
│   └── serve/
│       └── gateway.js        # Orchestrate initialize, tools/call, filter, forward
└── test/
    ├── cli.test.js
    ├── config.test.js
    ├── keychain.test.js
    ├── mcp.test.js
    ├── oauth.test.js
    └── serve.test.js
```

**Dependencies:** Zero external packages. Node.js 20+ stdlib only (`node:test`, `node:assert/strict`, `node:crypto`, `node:http`, `node:child_process`, `node:events`).

**Testing:** `node:test` + `node:assert/strict`. Manual mocks for `child_process` and HTTP.

---

## Error Handling

- **Upstream fails at startup:** Log warning to stderr, continue with remaining upstreams
- **Upstream fails on `tools/call`:** Return JSON-RPC error to client, gateway stays up
- **OAuth token expired:** Attempt refresh; if fails, return error for that call
- **Config file missing:** Gateway exits with clear error message
- **Config file invalid JSON / schema:** Exit with validation error, point to the problem
- **Keychain tool unavailable:** Exit with OS-specific installation instructions
- **`gmcp test` auth failure:** Exit code 1, error message to stderr

---

## Security Considerations

- OAuth tokens never touch `~/.gmcp.json` — exclusively in OS keychain
- `env` values (which may contain API keys) are in the config file — clearly documented that users should set restrictive file permissions (`chmod 600 ~/.gmcp.json`)
- PKCE with S256 challenge method for authorization code flow
- Redirect URI uses `localhost` only (loopback interface)
- Local callback server binds to `127.0.0.1` only (not `0.0.0.0`)
- `state` parameter validated to prevent CSRF
