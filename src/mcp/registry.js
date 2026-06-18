// ToolRegistry — Consolidates tools from multiple upstream MCP servers
// with name prefixing and allow/block list filtering.

export class ToolRegistry {
  /**
   * @param {Array<{ name: string, client: import('./stdio-client.js').StdioClient|import('./sse-client.js').SseClient }>} upstreams
   */
  constructor(upstreams) {
    /** @type {Array<{ name: string, client: object, tools: Array }>} */
    this.#upstreams = upstreams.map((u) => ({ name: u.name, client: u.client, tools: [] }));
  }

  /** @type {Array<{ name: string, client: object, tools: Array }>} */
  #upstreams;

  /** @type {Array} */
  #prefixedTools = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Connect to all upstreams in parallel, fetch their tool lists, prefix every
   * tool, apply allow/block filtering, and return the consolidated tool list.
   *
   * @returns {Promise<{ tools: Array }>} MCP-formatted tool list
   */
  async initialize() {
    // Connect all upstreams in parallel
    const results = await Promise.allSettled(
      this.#upstreams.map(async (up) => {
        await up.client.start();
        const rawTools = await up.client.listTools();
        up.tools = rawTools;
      })
    );

    // Log failed upstreams and collect tools from successful ones
    const allTools = [];

    for (let i = 0; i < this.#upstreams.length; i++) {
      const up = this.#upstreams[i];
      const result = results[i];

      if (result.status === "rejected") {
        console.error(`[${up.name}] Failed: ${result.reason?.message ?? result.reason}`);
        continue;
      }

      for (const tool of up.tools) {
        const prefixedName = `${up.name}__${tool.name}`;
        allTools.push({
          ...tool,
          name: prefixedName,
        });
      }
    }

    // Apply allow/block list filtering
    this.#prefixedTools = this.#applyFilters(allTools);

    return { tools: this.#prefixedTools };
  }

  /**
   * Forward a tool call to the correct upstream.
   *
   * @param {string} prefixedName - The prefixed tool name (e.g. "github__search_repos")
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} The upstream's result
   */
  async callTool(prefixedName, args) {
    // Parse prefix from tool name (split on first "__")
    const sepIdx = prefixedName.indexOf("__");
    if (sepIdx === -1) {
      throw new Error(`Unknown server: ${prefixedName}`);
    }

    const prefix = prefixedName.slice(0, sepIdx);
    const originalName = prefixedName.slice(sepIdx + 2);

    // Find upstream by prefix
    const up = this.#upstreams.find((u) => u.name === prefix);
    if (!up) {
      throw new Error(`Unknown server: ${prefix}`);
    }

    // Call the upstream
    const result = await up.client.request("tools/call", {
      name: originalName,
      arguments: args,
    });

    return result;
  }

  /**
   * Stop all upstream clients.
   */
  stop() {
    for (const up of this.#upstreams) {
      up.client.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: filtering
  // ---------------------------------------------------------------------------

  /**
   * Parse GTWMCP_ALLOW_LIST env var: split by comma, trim whitespace.
   * Returns null if the env var is not set or empty.
   *
   * @returns {string[]|null}
   */
  #readAllowList() {
    const raw = process.env.GTWMCP_ALLOW_LIST;
    if (!raw || raw.trim().length === 0) return null;
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  /**
   * Parse GTWMCP_BLOCK_LIST env var: split by comma, trim whitespace.
   * Returns null if the env var is not set or empty.
   *
   * @returns {string[]|null}
   */
  #readBlockList() {
    const raw = process.env.GTWMCP_BLOCK_LIST;
    if (!raw || raw.trim().length === 0) return null;
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  /**
   * Check whether a tool name matches a filter pattern.
   * - Exact match: filter === toolName
   * - Wildcard match: filter ends with "*" and toolName starts with the prefix
   *
   * @param {string} toolName
   * @param {string} filter
   * @returns {boolean}
   */
  #matchesFilter(toolName, filter) {
    if (filter === toolName) return true;
    if (filter.endsWith("*")) {
      const prefix = filter.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    return false;
  }

  /**
   * Apply allow/block list filtering to an array of tool objects.
   *
   * Rules:
   *   - If both allow and block: keep allow-matching, then remove block-matching
   *   - If only allow: keep only matching
   *   - If only block: remove matching
   *   - If neither: pass all
   *
   * @param {Array<{ name: string }>} tools
   * @returns {Array<{ name: string }>}
   */
  #applyFilters(tools) {
    const allowList = this.#readAllowList();
    const blockList = this.#readBlockList();

    const hasAllow = allowList && allowList.length > 0;
    const hasBlock = blockList && blockList.length > 0;

    // Neither: pass all
    if (!hasAllow && !hasBlock) return tools;

    // Determine which tools pass the allow filter
    let filtered;
    if (hasAllow) {
      filtered = tools.filter((tool) =>
        allowList.some((pattern) => this.#matchesFilter(tool.name, pattern))
      );
    } else {
      filtered = [...tools];
    }

    // Apply block filter
    if (hasBlock) {
      filtered = filtered.filter(
        (tool) => !blockList.some((pattern) => this.#matchesFilter(tool.name, pattern))
      );
    }

    return filtered;
  }
}
