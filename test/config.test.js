// Tests for Config loader and writer
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const origHome = process.env.HOME;

function tmpConfigPath() {
  const dir = join(tmpdir(), `mcphub-test-${randomBytes(4).toString("hex")}`);
  return { dir, path: join(dir, ".mcphub.json") };
}

async function setupConfig(content) {
  const { dir, path } = tmpConfigPath();
  await mkdir(dir, { recursive: true });
  process.env.HOME = dir;
  if (content) {
    await writeFile(path, JSON.stringify(content), "utf-8");
  }
  return { dir, path };
}

async function cleanup(dir) {
  process.env.HOME = origHome;
  try { await unlink(join(dir, ".mcphub.json")); } catch {}
  try { await unlink(join(dir, ".mcphub.json.tmp")); } catch {}
  // No need to rmdir — tmpdir cleanup is fine
}

describe("loadConfig", () => {
  afterEach(() => { process.env.HOME = origHome; });

  it("returns default empty config when file does not exist", async () => {
    const { dir } = await setupConfig(null);
    const { loadConfig } = await import("../src/config/loader.js");
    const config = await loadConfig();
    assert.deepEqual(config, { version: 1, servers: {} });
    await cleanup(dir);
  });

  it("loads and validates a valid config", async () => {
    const config = {
      version: 1,
      servers: {
        demo: { type: "stdio", enabled: true, command: "node", args: ["server.js"] },
      },
    };
    const { dir } = await setupConfig(config);
    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.deepEqual(loaded.servers.demo.command, "node");
    assert.deepEqual(loaded.servers.demo.args, ["server.js"]);
    await cleanup(dir);
  });

  it("loads sse server with oauth", async () => {
    const config = {
      version: 1,
      servers: {
        api: { type: "sse", enabled: true, url: "https://example.com/sse", oauth: true },
      },
    };
    const { dir } = await setupConfig(config);
    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.equal(loaded.servers.api.oauth, true);
    await cleanup(dir);
  });

  it("throws on invalid JSON", async () => {
    const { dir, path } = await setupConfig(null);
    await writeFile(path, "not valid json {{{ ", "utf-8");
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /Failed to parse/);
    await cleanup(dir);
  });

  it("throws when version is missing", async () => {
    const { dir } = await setupConfig({ servers: {} });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /version/);
    await cleanup(dir);
  });

  it("throws when server type is invalid", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: { bad: { type: "websocket", enabled: true } },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /invalid type/);
    await cleanup(dir);
  });

  it("throws when stdio server is missing command", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: { bad: { type: "stdio", enabled: true } },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /command/);
    await cleanup(dir);
  });

  it("throws when sse server is missing url", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: { bad: { type: "sse", enabled: true } },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /url/);
    await cleanup(dir);
  });

  it("throws when enabled is not boolean", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: { bad: { type: "stdio", enabled: "yes", command: "ls" } },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /enabled/);
    await cleanup(dir);
  });

  it("accepts description field", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        demo: { type: "stdio", enabled: true, command: "ls", description: "List files" },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.equal(loaded.servers.demo.description, "List files");
    await cleanup(dir);
  });

  it("accepts timeout field on SSE server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        api: { type: "sse", enabled: true, url: "https://example.com/sse", timeout: 60000 },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.equal(loaded.servers.api.timeout, 60000);
    await cleanup(dir);
  });

  it("accepts timeout field on stdio server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        cmd: { type: "stdio", enabled: true, command: "ls", timeout: 10000 },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.equal(loaded.servers.cmd.timeout, 10000);
    await cleanup(dir);
  });

  it("rejects zero timeout on server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        bad: { type: "sse", enabled: true, url: "https://example.com/sse", timeout: 0 },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /timeout/);
    await cleanup(dir);
  });

  it("rejects negative timeout on server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        bad: { type: "sse", enabled: true, url: "https://example.com/sse", timeout: -1 },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /timeout/);
    await cleanup(dir);
  });

  it("rejects non-number timeout on server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        bad: { type: "sse", enabled: true, url: "https://example.com/sse", timeout: "fast" },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /timeout/);
    await cleanup(dir);
  });

  it("rejects invalid timeout on stdio server", async () => {
    const { dir } = await setupConfig({
      version: 1,
      servers: {
        bad: { type: "stdio", enabled: true, command: "ls", timeout: 0 },
      },
    });
    const { loadConfig } = await import("../src/config/loader.js");
    await assert.rejects(loadConfig, /timeout/);
    await cleanup(dir);
  });
});

describe("writeConfig", () => {
  afterEach(() => { process.env.HOME = origHome; });

  it("writes config to disk", async () => {
    const { dir } = await setupConfig(null);
    const { writeConfig } = await import("../src/config/writer.js");
    const config = { version: 1, servers: { test: { type: "stdio", enabled: true, command: "echo" } } };
    await writeConfig(config);

    const { loadConfig } = await import("../src/config/loader.js");
    const loaded = await loadConfig();
    assert.equal(loaded.servers.test.command, "echo");
    await cleanup(dir);
  });
});
