# mcphub — MCP Gateway

[![CI](https://github.com/pcandido/mcphub/actions/workflows/ci.yml/badge.svg)](https://github.com/pcandido/mcphub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pcandido/mcphub)](https://www.npmjs.com/package/@pcandido/mcphub)
[![node](https://img.shields.io/node/v/@pcandido/mcphub)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)

A zero-dependency MCP gateway. Connect multiple AI harnesses to multiple MCP
servers through a single, centrally-managed stdio interface. No overhead, no
bloat — just the Node.js stdlib. Secrets stay in the OS keychain, never in
config files.

Supports **stdio** (subprocess) and **SSE** (HTTP with Server-Sent Events /
Streamable HTTP) transports. OAuth servers get full PKCE auth flow with
automatic token refresh and dynamic client registration.

![Architecture](docs/diagrams/architecture.png)

## Install

```bash
npm install -g @pcandido/mcphub
```

Requires Node.js >= 22.

## Quick Start

Add a stdio MCP server:

```bash
$ mcphub add github --type stdio --command npx --args "-y,@modelcontextprotocol/server-github" --description "GitHub MCP"
Server "github" added.
```

Add an SSE MCP server with OAuth:

```bash
$ mcphub add jira --type sse --url https://mcp.jira.example.com/sse --oauth --description "Jira MCP"
Server "jira" added.
```

List servers (shows type, status, and auth state for OAuth servers):

```bash
$ mcphub list
NAME    TYPE   STATUS       DESCRIPTION
------  -----  -----------  -----------
github  stdio  ✅ enabled   GitHub MCP
jira    sse    ✅ enabled   Jira MCP
```

Authenticate an OAuth server:

```bash
$ mcphub auth jira
[jira] https://mcp.jira.example.com/sse
  Metadata discovered.
  Client registered (abc123).
  ✅ Authenticated.

$ mcphub auth --force          # re-authenticate all OAuth servers
```

List tools from a server (connects directly and fetches the live tool list):

```bash
$ mcphub get jira
jira (sse) — https://mcp.jira.example.com/sse
Listing tools...

  1. search_jira_issues: Search Jira issues using JQL
  2. get_jira_issue: Get a specific Jira issue

2 tools available.
```

Enable/disable servers without removing them:

```bash
$ mcphub disable github
Server "github" disabled.

$ mcphub enable github
Server "github" enabled.
```

Remove a server (also cleans up keychain secrets):

```bash
$ mcphub remove jira
Server "jira" removed.
```

## CLI Reference

```
mcphub add     <name>    Add or update an MCP server
mcphub remove  <name>    Remove an MCP server (and its keychain secrets)
mcphub get     <name>    Connect to server and list its tools live
mcphub list              List all servers with type, status, and auth state
mcphub auth    [name]    Authenticate OAuth servers (--force to re-auth)
mcphub enable  <name>    Enable a server (include it in the gateway)
mcphub disable <name>    Disable a server (skip it in the gateway)
mcphub serve             Start the MCP gateway in stdio mode
```

### `add` flags

| Flag | Description |
|---|---|
| `--type stdio\|sse` | Transport type (required in non-interactive mode) |
| `--command <cmd>` | Binary to spawn (required for stdio) |
| `--args <a1,a2,...>` | Comma-separated args for the subprocess |
| `--env <K=V,...>` | Comma-separated env vars for the subprocess |
| `--url <url>` | SSE endpoint URL (required for sse) |
| `--description <desc>` | Human-readable description |
| `--oauth` | Mark the server as requiring OAuth (SSE only) |

Omitting `--type` enters interactive mode — mcphub will prompt for each field.

### `auth` flags

| Flag | Description |
|---|---|
| `--force` | Re-authenticate even if a valid token exists |
| `--client-id <id>` | Use a specific client ID (skip dynamic registration) |
| `--scopes <scopes>` | Request specific scopes |

## Gateway

The gateway (`mcphub serve`) speaks MCP over stdio to the AI harness. On startup it:

1. Reads `~/.mcphub.json`
2. Connects to all **enabled** upstream servers in parallel
3. Calls `initialize` and `tools/list` on each server
4. Prefixes every tool with the server name: `<server>__<tool>`
5. Applies allow/block list filters (see below)
6. Presents a single consolidated tool list
7. Proxies `tools/call` requests to the correct upstream

![Gateway](docs/diagrams/gateway.png)

Failed upstreams are logged and skipped — the gateway keeps running with the
remaining servers. OAuth tokens are auto-refreshed before each call if they're
within 30 seconds of expiry.

## Tool Filtering

Control which tools are exposed via environment variables:

| Variable | Behavior |
|---|---|
| `MCPHUB_ALLOW_LIST` | Only matching tools pass |
| `MCPHUB_BLOCK_LIST` | All tools **except** matching pass |
| Both set | Allow first, then block removes from that subset |
| Neither set | All tools pass |

Patterns support exact match and trailing `*` wildcard:

```bash
# Expose only read tools
MCPHUB_ALLOW_LIST="github__read_*,github__search_*,github__list_*"

# Expose everything except destructive tools
MCPHUB_BLOCK_LIST="github__delete_*,github__admin_*"
```

## Configuration

`~/.mcphub.json`:

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
      "description": "Jira MCP",
      "url": "https://mcp.jira.example.com/sse",
      "headers": {
        "X-Custom-Header": "value"
      },
      "oauth": true
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `type` | Yes | `"stdio"` or `"sse"` |
| `enabled` | Yes | `true` to include in gateway, `false` to skip |
| `description` | No | Human-readable label shown in `list` |
| `command` | Required (stdio) | Binary or command to spawn |
| `args` | No | Array of string arguments for the subprocess |
| `env` | No | Extra environment variables for the subprocess |
| `url` | Required (sse) | SSE endpoint URL |
| `headers` | No | Custom HTTP headers for SSE requests |
| `oauth` | No | `true` if the server requires OAuth (SSE only) |

When `"oauth": true`, all OAuth data (tokens, client ID, endpoints) lives in
the OS keychain — never in this file.

## OAuth

mcphub implements Authorization Code Flow with PKCE (RFC 7636) for SSE servers.
The flow is fully automatic:

### Discovery (3 strategies, tried in order)

1. **Path-level** — `GET <serverUrl>/.well-known/oauth-authorization-server`
2. **Root-level** — `GET <origin>/.well-known/oauth-protected-resource` → follow `authorization_server`
3. **WWW-Authenticate** — `POST` a minimal `initialize` request, read `resource_metadata` from the 401 response header

### Dynamic Client Registration (RFC 7591)

If the server exposes a `registration_endpoint` in its metadata, mcphub
auto-registers a client. The `client_id` is saved to the keychain and reused
on subsequent auth flows. Use `--client-id` to override and skip DCR.

### The flow

1. Discover OAuth metadata from the server URL
2. Register a client (or use the provided `--client-id`)
3. Generate PKCE code verifier + challenge
4. Open the browser at the authorization URL
5. Start a local HTTP server on `127.0.0.1:{port}` to catch the callback
6. Exchange the authorization code for tokens
7. Store access + refresh tokens and metadata in the OS keychain

![OAuth Flow](docs/diagrams/oauth.png)

### Token refresh

At runtime, `mcphub serve` checks token expiry before each call. If the token
expires within 30 seconds, it silently refreshes using the stored refresh token
and persists the new token set back to the keychain. If refresh fails, the
server is skipped with a warning — run `mcphub auth` to re-authenticate.

### Keychain

| Platform | Backend |
|---|---|
| macOS | `/usr/bin/security` (Keychain Access) |
| Linux | `secret-tool` (libsecret / GNOME Keyring) |

## Use with Claude Code

Point Claude Code's MCP config at the gateway:

```json
{
  "mcpServers": {
    "mcphub": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pcandido/mcphub", "serve"]
    }
  }
}
```

All your upstream MCP tools appear prefixed and unified in Claude Code.

## Transports

### stdio

Spawns a subprocess and communicates via JSON-RPC 2.0 over stdin/stdout.
Stderr from the child is logged with the server name as prefix. Process
exit kills pending requests and cleans up.

### SSE / Streamable HTTP

Opens a GET connection to the SSE endpoint to receive events and discover the
POST endpoint (via the `endpoint` event). Falls back to the original URL if no
endpoint event arrives within 5 seconds. Sends JSON-RPC requests via POST.
Accepts both plain JSON and SSE-framed responses. Supports OAuth Bearer tokens
via the `Authorization` header.

## Development

```bash
npm install
npm run check   # syntax validation (all .js files)
npm test        # 57 tests
```

Zero external dependencies. Node.js 22+ stdlib only.
