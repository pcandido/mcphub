// Tests for Registry — tool consolidation, prefixing, and filtering
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/mcp/registry.js";

// Fake MCP client that returns preset tools
class FakeClient {
  constructor(name, tools, shouldFail = false) {
    this.name = name;
    this._tools = tools;
    this._shouldFail = shouldFail;
    this._started = false;
  }
  async start() {
    if (this._shouldFail) throw new Error(`${this.name}: connection refused`);
    this._started = true;
    return {};
  }
  async listTools() {
    return this._tools;
  }
  async request(method, params) {
    if (method === "tools/call") {
      return { content: [{ type: "text", text: `result from ${this.name}: ${params.name}` }] };
    }
    return {};
  }
  stop() {}
}

const SAMPLE_TOOLS = [
  { name: "search", description: "Search issues", inputSchema: { type: "object" } },
  { name: "create", description: "Create issue", inputSchema: { type: "object" } },
  { name: "read", description: "Read issue", inputSchema: { type: "object" } },
];

describe("ToolRegistry", () => {
  describe("initialize", () => {
    it("connects multiple upstreams and prefixes tools", async () => {
      const upstreams = [
        { name: "github", client: new FakeClient("github", [
          { name: "search", description: "Search GH" },
          { name: "create_pr", description: "Create PR" },
        ]) },
        { name: "jira", client: new FakeClient("jira", [
          { name: "search", description: "Search Jira" },
          { name: "get_issue", description: "Get Jira issue" },
        ]) },
      ];
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();

      assert.ok(Array.isArray(result.tools));
      assert.equal(result.tools.length, 4);

      const names = result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "github__create_pr",
        "github__search",
        "jira__get_issue",
        "jira__search",
      ]);

      assert.equal(result.tools[0].description, "Search GH");
    });

    it("skips failed upstreams and continues", async () => {
      const upstreams = [
        { name: "bad", client: new FakeClient("bad", [], true) },
        { name: "good", client: new FakeClient("good", [
          { name: "ping", description: "Pong" },
        ]) },
      ];
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();

      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0].name, "good__ping");
    });
  });

  describe("callTool", () => {
    it("routes to the correct upstream by prefix", async () => {
      const client = new FakeClient("jira", SAMPLE_TOOLS);
      const upstreams = [{ name: "jira", client }];
      const registry = new ToolRegistry(upstreams);
      await registry.initialize();

      const result = await registry.callTool("jira__search", { query: "bug" });
      assert.deepEqual(result, { content: [{ type: "text", text: "result from jira: search" }] });
    });

    it("throws for unknown server prefix", async () => {
      const registry = new ToolRegistry([]);
      await assert.rejects(
        () => registry.callTool("unknown__tool", {}),
        /Unknown server: unknown/
      );
    });

    it("throws when tool name has no prefix separator", async () => {
      const registry = new ToolRegistry([]);
      await assert.rejects(
        () => registry.callTool("no-prefix-at-all", {}),
        /Unknown server/
      );
    });
  });

  describe("filtering", () => {
    let upstreams;
    beforeEach(() => {
      upstreams = [
        { name: "srv", client: new FakeClient("srv", SAMPLE_TOOLS) },
      ];
      delete process.env.MCPHUB_ALLOW_LIST;
      delete process.env.MCPHUB_BLOCK_LIST;
    });
    afterEach(() => {
      delete process.env.MCPHUB_ALLOW_LIST;
      delete process.env.MCPHUB_BLOCK_LIST;
    });

    it("passes all tools when no filters are set", async () => {
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      assert.equal(result.tools.length, 3);
    });

    it("filters by allow list", async () => {
      process.env.MCPHUB_ALLOW_LIST = "srv__search,srv__read";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      const names = result.tools.map((t) => t.name);
      assert.deepEqual(names, ["srv__search", "srv__read"]);
    });

    it("filters by block list", async () => {
      process.env.MCPHUB_BLOCK_LIST = "srv__create";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      const names = result.tools.map((t) => t.name);
      assert.deepEqual(names, ["srv__search", "srv__read"]);
    });

    it("allow then block when both are set", async () => {
      process.env.MCPHUB_ALLOW_LIST = "srv__search,srv__create";
      process.env.MCPHUB_BLOCK_LIST = "srv__create";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      const names = result.tools.map((t) => t.name);
      assert.deepEqual(names, ["srv__search"]);
    });

    it("supports wildcard allow", async () => {
      process.env.MCPHUB_ALLOW_LIST = "srv__*";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      assert.equal(result.tools.length, 3);
    });

    it("supports wildcard block", async () => {
      process.env.MCPHUB_BLOCK_LIST = "srv__crea*";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      const names = result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["srv__read", "srv__search"]);
    });

    it("trims whitespace from filter patterns", async () => {
      process.env.MCPHUB_ALLOW_LIST = " srv__search , srv__read ";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      assert.equal(result.tools.length, 2);
    });

    it("empty allow list env var is treated as not set", async () => {
      process.env.MCPHUB_ALLOW_LIST = "  ";
      const registry = new ToolRegistry(upstreams);
      const result = await registry.initialize();
      assert.equal(result.tools.length, 3);
    });
  });
});
