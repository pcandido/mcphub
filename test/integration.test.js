// Integration test — end-to-end gateway with mock MCP server
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "mcphub.js");
const MOCK_SERVER = join(__dirname, "fixtures", "mock-mcp-server.js");

const origHome = process.env.HOME;

async function setupConfig(servers) {
  const testDir = join(tmpdir(), `mcphub-int-${randomBytes(4).toString("hex")}`);
  await mkdir(testDir, { recursive: true });
  process.env.HOME = testDir;
  const config = { version: 1, servers };
  await writeFile(join(testDir, ".mcphub.json"), JSON.stringify(config), "utf-8");
  return testDir;
}

async function cleanup(dir) {
  process.env.HOME = origHome;
  try { await unlink(join(dir, ".mcphub.json")); } catch {}
}

// Send a JSON-RPC request and get the matching response
function gatewayRequest(proc, rl, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout for ${method}`)), 10000);

    const handler = (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          clearTimeout(timer);
          rl.removeListener("line", handler);
          resolve(msg);
        }
      } catch {}
    };

    rl.on("line", handler);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

describe("Gateway Integration", () => {
  let testDir;

  afterEach(async () => {
    if (testDir) await cleanup(testDir);
  });

  it("initialize returns consolidated prefixed tools", async () => {
    testDir = await setupConfig({
      mock: {
        type: "stdio",
        enabled: true,
        command: "node",
        args: [MOCK_SERVER],
      },
    });

    const proc = spawn("node", [BIN, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });
    const rl = createInterface({ input: proc.stdout });

    const initResponse = await gatewayRequest(proc, rl, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    assert.equal(initResponse.result.serverInfo.name, "mcphub");
    assert.equal(initResponse.result.protocolVersion, "2024-11-05");

    const toolNames = initResponse.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, ["mock__add", "mock__echo", "mock__get_time"]);

    proc.kill();
  });

  it("tools/call proxies to the correct upstream", async () => {
    testDir = await setupConfig({
      mock: {
        type: "stdio",
        enabled: true,
        command: "node",
        args: [MOCK_SERVER],
      },
    });

    const proc = spawn("node", [BIN, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });
    const rl = createInterface({ input: proc.stdout });

    // First initialize
    await gatewayRequest(proc, rl, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    // Then call a tool
    const callResponse = await gatewayRequest(proc, rl, 2, "tools/call", {
      name: "mock__echo",
      arguments: { message: "hello integration" },
    });

    assert.equal(callResponse.result.content[0].text, "Echo: hello integration");

    proc.kill();
  });

  it("handles disabled servers", async () => {
    testDir = await setupConfig({
      mock: {
        type: "stdio",
        enabled: false,
        command: "node",
        args: [MOCK_SERVER],
      },
    });

    const proc = spawn("node", [BIN, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });
    const rl = createInterface({ input: proc.stdout });

    const initResponse = await gatewayRequest(proc, rl, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    assert.deepEqual(initResponse.result.tools, []);
    proc.kill();
  });

  it("returns error for unknown method", async () => {
    testDir = await setupConfig({});

    const proc = spawn("node", [BIN, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });
    const rl = createInterface({ input: proc.stdout });

    const response = await gatewayRequest(proc, rl, 1, "unknown_method", {});
    assert.equal(response.error.code, -32601);
    proc.kill();
  });
});

describe("CLI Integration", () => {
  let testDir;

  afterEach(async () => {
    if (testDir) await cleanup(testDir);
  });

  function runCLI(args) {
    return new Promise((resolve) => {
      const proc = spawn("node", [BIN, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: process.env.HOME },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c) => (stdout += c.toString()));
      proc.stderr.on("data", (c) => (stderr += c.toString()));
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("mcphub list shows servers", async () => {
    testDir = await setupConfig({
      demo: {
        type: "stdio",
        enabled: true,
        command: "echo",
        description: "Demo server",
      },
      off: {
        type: "stdio",
        enabled: false,
        command: "false",
        description: "Disabled",
      },
    });

    const { stdout } = await runCLI(["list"]);
    assert.match(stdout, /demo/);
    assert.match(stdout, /stdio/);
    assert.match(stdout, /✅.*enabled/);
    assert.match(stdout, /off/);
    assert.match(stdout, /❌.*disabled/);
  });

  it("mcphub get lists tools from a server", async () => {
    testDir = await setupConfig({
      mock: {
        type: "stdio",
        enabled: true,
        command: "node",
        args: [MOCK_SERVER],
        description: "Mock server",
      },
    });

    const { stdout, code } = await runCLI(["get", "mock"]);
    assert.equal(code, 0);
    assert.match(stdout, /mock \(stdio\)/);
    assert.match(stdout, /echo/);
    assert.match(stdout, /add/);
    assert.match(stdout, /get_time/);
    assert.match(stdout, /3 tools available/);
  });

  it("mcphub enable / disable toggles server", async () => {
    testDir = await setupConfig({
      demo: { type: "stdio", enabled: false, command: "echo" },
    });

    const { stdout: out1 } = await runCLI(["enable", "demo"]);
    assert.match(out1, /enabled/);

    // Re-read config to verify
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(testDir, ".mcphub.json"), "utf-8");
    const config = JSON.parse(content);
    assert.equal(config.servers.demo.enabled, true);
  });
});
