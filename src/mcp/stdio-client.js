// Stdio MCP Client — manages a child process that speaks MCP protocol
// over stdin/stdout.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequest, parseMessage } from "../mcp/protocol.js";

export class StdioClient {
  /** @type {import('node:child_process').ChildProcess|null} */
  #proc = null;

  /** @type {import('node:readline').Interface|null} */
  #rl = null;

  /** @type {string} */
  #serverName;

  /** @type {{ command: string, args?: string[], env?: Record<string,string> }} */
  #config;

  /** @type {number} */
  #nextId = 1;

  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  #pending = new Map();

  /** @type {boolean} */
  #started = false;

  /**
   * @param {string} serverName
   * @param {{ command: string, args?: string[], env?: Record<string,string> }} config
   */
  constructor(serverName, config) {
    this.#serverName = serverName;
    this.#config = config;
  }

  get running() {
    return this.#proc !== null && !this.#proc.killed && this.#proc.exitCode === null;
  }

  /**
   * Spawn the child process and run the MCP initialize handshake.
   * @returns {Promise<object>} the initialize response
   */
  async start() {
    if (this.running) throw new Error(`${this.#serverName}: already started`);

    // Merge config.env into process.env (child sees the union)
    const mergedEnv = { ...process.env, ...(this.#config.env ?? {}) };

    this.#proc = spawn(this.#config.command, this.#config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
    });

    this.#proc.on("exit", (code, signal) => {
      this.#started = false;
      // Reject every outstanding request when the process dies
      for (const [id, entry] of this.#pending) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(
            `${this.#serverName}: process exited (code=${code}, signal=${signal}) before request ${id} completed`
          )
        );
      }
      this.#pending.clear();
    });

    // Log stderr with prefix
    if (this.#proc.stderr) {
      this.#proc.stderr.on("data", (chunk) => {
        console.error(`[${this.#serverName}] ${String(chunk).trimEnd()}`);
      });
    }

    // Set up line-based JSON reading on stdout
    this.#rl = createInterface({ input: this.#proc.stdout, crlfDelay: Infinity });

    this.#rl.on("line", (line) => {
      let msg;
      try {
        msg = parseMessage(line);
      } catch {
        // Ignore unparseable lines (stderr already logged above)
        return;
      }
      if (!msg) return;

      this.#routeMessage(msg);
    });

    // -------------------------------------------------------
    // Initialize handshake (MCP spec §3.1)
    // -------------------------------------------------------
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcphub", version: "0.1.0" },
    });

    this.#started = true;
    return initResult;
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 30000) {
    if (!this.#proc) throw new Error(`${this.#serverName}: not started`);

    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.#serverName}: request "${method}" (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });

      const reqMsg = createRequest(id, method, params);
      this.#proc.stdin.write(JSON.stringify(reqMsg) + "\n");
    });
  }

  /**
   * Send a notification (no response expected).
   * @param {string} method
   * @param {object} [params]
   */
  sendNotification(method, params) {
    if (!this.#proc) throw new Error(`${this.#serverName}: not started`);

    const notif = { jsonrpc: "2.0", method };
    if (params !== undefined) notif.params = params;

    this.#proc.stdin.write(JSON.stringify(notif) + "\n");
  }

  /**
   * Call tools/list and return result.tools.
   * @returns {Promise<Array>}
   */
  async listTools() {
    const result = await this.request("tools/list");
    return result.tools;
  }

  /**
   * Kill the child process and clean up resources.
   */
  stop() {
    if (this.#rl) {
      this.#rl.close();
      this.#rl = null;
    }
    if (this.#proc) {
      this.#proc.kill();
      this.#proc = null;
    }
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${this.#serverName}: stopped`));
    }
    this.#pending.clear();
    this.#started = false;
  }

  // -------------------------------------------------------
  // Internal routing
  // -------------------------------------------------------

  /**
   * Route a parsed message: response by id, or log unhandled.
   * @param {object} msg
   */
  #routeMessage(msg) {
    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.#pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.#pending.delete(msg.id);

        if (msg.error) {
          const e = new Error(
            `${this.#serverName}: error ${msg.error.code}: ${msg.error.message}`
          );
          entry.reject(e);
        } else {
          entry.resolve(msg.result);
        }
      }
      // else: response for an id we aren't waiting for — ignore
    }
    // Inbound requests / notifications from the server are silently ignored
    // (the gateway does not implement a server role).
  }
}
