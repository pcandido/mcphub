// MCP Gateway Server
// Speaks MCP over stdio to the client and proxies requests to upstream servers.

import { createInterface } from "node:readline";
import {
  parseMessage,
  encodeMessage,
  ErrorCode,
} from "../mcp/protocol.js";
import { ToolRegistry } from "../mcp/registry.js";
import { loadConfig } from "../config/loader.js";
import { StdioClient } from "../mcp/stdio-client.js";
import { SseClient } from "../mcp/sse-client.js";
import { refreshTokenIfNeeded } from "../oauth/refresh.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a JSON-RPC message to stdout, catching broken-pipe errors.
 * When stdout is broken the upstream process is gone — exit gracefully.
 */
function safeWrite(obj) {
  try {
    process.stdout.write(encodeMessage(obj));
  } catch (err) {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      // Upstream client has disconnected — exit quietly.
      process.exit(0);
    }
    // Unexpected write error — log and rethrow so the outer handler
    // can decide whether to keep going.
    console.error("[mcphub] stdout write failed:", err.message);
    throw err;
  }
}

/**
 * Build a JSON-RPC error response.
 */
function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
let cachedTools = [];

export async function startGateway() {
  // ═══════════════════════════════════════════════════════════
  // Process-level safety nets
  // ═══════════════════════════════════════════════════════════

  // Prevent unhandled promise rejections from crashing the process.
  // This is a safety net — all async code is already try/caught; this
  // catches any edge case that slips through.
  process.on("unhandledRejection", (reason) => {
    console.error("[mcphub] unhandled rejection:", reason);
  });

  // Prevent uncaught exceptions from crashing the process.
  process.on("uncaughtException", (err) => {
    console.error("[mcphub] uncaught exception:", err.message);
    // EPIPE means the parent process disconnected — exit gracefully.
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      process.exit(0);
    }
    // For any other unexpected error, continue running.
    // The error was logged; the gateway keeps serving remaining clients.
  });

  // 1. Load config
  const config = await loadConfig();

  // 2. Filter enabled servers only
  const allServers = Object.entries(config.servers ?? {});
  const enabled = allServers.filter(([, s]) => s.enabled);

  if (enabled.length === 0) {
    console.error("[mcphub] No enabled servers found in config");
  }

  // 3. Create upstream clients (synchronous — no network I/O yet)
  /** @type {Array<{ name: string, client: object, server: object }>} */
  const upstreams = [];

  for (const [name, server] of enabled) {
    try {
      if (server.type === "stdio") {
        const client = new StdioClient(name, {
          command: server.command,
          args: server.args,
          env: server.env,
        });
        upstreams.push({ name, client, server });
      } else if (server.type === "sse") {
        const client = new SseClient(name, {
          url: server.url,
          headers: server.headers,
          oauth: server.oauth,
          timeout: server.timeout,
          insecure: server.insecure,
        });
        upstreams.push({ name, client, server });
      }
    } catch (err) {
      console.error(
        `[mcphub] Failed to create client for "${name}": ${err.message}`
      );
    }
  }

  // 4. Resolve OAuth tokens in parallel for SSE servers
  const oauthResults = await Promise.allSettled(
    upstreams
      .filter((u) => u.server.type === "sse" && u.server.oauth)
      .map(async (u) => {
        const token = await refreshTokenIfNeeded(u.name);
        return { name: u.name, token };
      })
  );

  // Apply tokens and filter out servers with missing OAuth
  const oauthByServer = {};
  for (const result of oauthResults) {
    if (result.status === "fulfilled" && result.value) {
      oauthByServer[result.value.name] = result.value.token;
    } else {
      const name =
        result.status === "fulfilled" ? result.value?.name : "unknown";
      console.error(
        `[mcphub] OAuth token resolution failed for "${name}"`
      );
    }
  }

  const activeUpstreams = upstreams.filter((u) => {
    if (u.server.type === "sse" && u.server.oauth) {
      const token = oauthByServer[u.name];
      if (!token) {
        console.error(
          `[mcphub] No valid OAuth token for SSE server "${u.name}" — skipping`
        );
        return false;
      }
      u.client.setAccessToken(token);
    }
    return true;
  });

  // 5. Create registry
  const registry = new ToolRegistry(activeUpstreams);

  // 6. Start stdio readline loop
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    let msg;
    try {
      msg = parseMessage(line);
    } catch {
      safeWrite(errorResponse(null, ErrorCode.PARSE_ERROR, "Parse error"));
      return;
    }

    if (!msg) return;

    // Notifications have a method but no id
    if (msg.method && msg.id === undefined) {
      console.error(`[mcphub] notification: ${msg.method}`);
      return;
    }

    // Must have method and id to be a request
    if (!msg.method || msg.id === undefined) {
      safeWrite(
        errorResponse(msg.id ?? null, ErrorCode.INVALID_REQUEST, "Invalid request")
      );
      return;
    }

    try {
      if (msg.method === "initialize") {
        let toolList = [];
        try {
          const initResult = await registry.initialize();
          toolList = initResult.tools;
          cachedTools = toolList;
        } catch (err) {
          console.error(
            `[mcphub] initialize failed, returning empty tools: ${err.message}`
          );
        }

        const result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcphub", version: "0.1.0" },
          tools: toolList,
        };

        safeWrite({ jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.method === "tools/list") {
        safeWrite({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: cachedTools },
        });
      } else if (msg.method === "tools/call") {
        const name = msg.params?.name;

        if (!name || typeof name !== "string") {
          safeWrite(
            errorResponse(msg.id, ErrorCode.INVALID_PARAMS, "Missing or invalid tool name")
          );
          return;
        }

        let result;
        try {
          result = await registry.callTool(name, msg.params?.arguments);
        } catch (err) {
          if (err.message && err.message.startsWith("Unknown server:")) {
            safeWrite(
              errorResponse(
                msg.id,
                ErrorCode.METHOD_NOT_FOUND,
                `Tool not found: ${name}`
              )
            );
            return;
          }
          // Re-throw for the outer catch to handle as internal error
          throw err;
        }

        // Format response as MCP tool result
        let content;
        if (result && Array.isArray(result.content)) {
          // Already has a content array — pass through
          content = result.content;
        } else {
          // Wrap scalar result in a text content block
          content = [{ type: "text", text: JSON.stringify(result) }];
        }

        safeWrite({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content },
        });
      } else {
        // Unknown method
        safeWrite(
          errorResponse(
            msg.id,
            ErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${msg.method}`
          )
        );
      }
    } catch (err) {
      // Internal errors — catch everything, never crash the gateway.
      console.error(`[mcphub] request handler error: ${err.message}`);
      try {
        safeWrite(
          errorResponse(
            msg.id,
            ErrorCode.INTERNAL_ERROR,
            err.message || "Internal error"
          )
        );
      } catch {
        // If even the error response can't be written (broken pipe),
        // the upstream is gone — exit gracefully.
        process.exit(0);
      }
    }
  });

  // 7. Graceful shutdown
  const shutdown = async () => {
    rl.close();
    registry.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
