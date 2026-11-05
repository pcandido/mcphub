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
