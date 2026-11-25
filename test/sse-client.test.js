// Tests for SseClient — Streamable HTTP transport
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SseClient } from "../src/mcp/sse-client.js";

// Minimal Streamable HTTP MCP server: POST answers JSON-RPC inline.
// It never sends an SSE `endpoint` event, and it holds GET streams open
// in silence — the shape of every real server we measured.
function startServer() {
  const state = { getCount: 0, posts: [] };

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      state.getCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders(); // headers go out, then silence — stream stays open
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      state.posts.push({ path: req.url, method: msg.method });

      let result = {};
      if (msg.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };
      }
      if (msg.method === "tools/list") {
        result = { tools: [{ name: "ping", description: "Pong" }] };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });

  return { server, state };
}

describe("SseClient", () => {
  let server, state, baseUrl;

  before(async () => {
    ({ server, state } = startServer());
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/mcp`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("posts initialize straight to the configured URL, without a GET", async () => {
    const client = new SseClient("test", { url: baseUrl });
    await client.start();

    assert.equal(state.getCount, 0, "must not open a legacy SSE GET stream");
    assert.equal(state.posts[0].path, "/mcp");
    assert.equal(state.posts[0].method, "initialize");
  });

  it("start() does not wait for a legacy endpoint event", async () => {
    const client = new SseClient("test", { url: baseUrl });

    const s = Date.now();
    await client.start();
    const elapsed = Date.now() - s;

    assert.ok(
      elapsed < 2000,
      `start() took ${elapsed}ms — it is still waiting out the 5s endpoint timer`
    );
  });

  it("listTools() returns the tools from the POST response", async () => {
    const client = new SseClient("test", { url: baseUrl });
    await client.start();

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["ping"]);
  });

  it("running reflects the connection lifecycle", async () => {
    const client = new SseClient("test", { url: baseUrl });
    assert.equal(client.running, false);

    await client.start();
    assert.equal(client.running, true);

    client.stop();
    assert.equal(client.running, false);
  });
});

// A 401 that survives the refresh: the server's own diagnosis must reach the
// user, because "expired" and "refused" are otherwise the same message.
describe("SseClient — OAuth 401", () => {
  const CHALLENGE =
    'Bearer error="invalid_token", scope="openid profile email mcp_rap_permission", ' +
    'error_description="The provided bearer token is invalid"';

  function startRejectingServer() {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": CHALLENGE,
        });
        res.end(
          JSON.stringify({
            error: "invalid_token",
            error_description:
              "Authentication failed. The provided bearer token is invalid, expired, or no longer recognized.",
          }),
        );
      });
    });
    return server;
  }

  it("reports the server's error and the required scope instead of a bare expiry", async () => {
    const server = startRejectingServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;

    try {
      const client = new SseClient("no-such-server-in-keychain", { url });
      await assert.rejects(
        () => client.listTools(),
        (err) => {
          assert.match(err.message, /^OAuth token expired/);
          assert.match(err.message, /no longer recognized/);
          assert.match(err.message, /server requires scope: openid profile email mcp_rap_permission/);
          assert.equal(err.statusCode, 401);
          return true;
        },
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
