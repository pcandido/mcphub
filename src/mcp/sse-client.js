// MCP SSE Client — HTTP-based transport that connects to an MCP endpoint
//
// Implements the Streamable HTTP transport from the MCP specification:
//   - Sends JSON-RPC requests and notifications via POST to the configured URL
//   - Reads the JSON-RPC response from the POST response body
//   - Handles OAuth token management via an Authorization header

import { createRequest, createNotification } from "../mcp/protocol.js";
import { refreshTokenIfNeeded } from "../oauth/refresh.js";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// SseClient
// ---------------------------------------------------------------------------

export class SseClient {
  /**
   * @param {string} serverName
   * @param {object} config
   * @param {string} config.url        SSE endpoint URL
   * @param {object} [config.headers]  Extra HTTP headers
   * @param {object} [config.oauth]    OAuth configuration (stored, not used directly)
   */
  constructor(serverName, config) {
    this.serverName = serverName;
    this.config = config;
    this.url = new URL(config.url);

    /** @type {string} POST target — the configured URL */
    this._endpointUrl = this.url.href;

    /** @type {boolean} */
    this._started = false;

    /** @type {string|null} */
    this._accessToken = null;

    /** @type {number} default request timeout in ms */
    this._timeout = config.timeout || 30000;

    /** @type {number} */
    this._nextId = 1;

    /** @type {boolean} bypass certificate validation for self-signed certs */
    this._insecure = !!config.insecure;

    /** @type {import('node:https').Agent|undefined} */
    this._agent = this._insecure
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * Run the MCP initialize handshake.
   *
   * The POST goes straight to the configured URL. The Streamable HTTP
   * transport does not require a prior GET stream, and there is no
   * `endpoint` discovery event to await.
   *
   * @returns {Promise<object>} initialize response
   */
  async start() {
    const initResponse = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "mcphub",
        version: "0.1.0",
      },
    });

    this._started = true;
    return initResponse;
  }

  /**
   * Mark the client as stopped.
   */
  stop() {
    this._started = false;
  }

  /**
   * Whether the client has completed the initialize handshake.
   *
   * @returns {boolean}
   */
  get running() {
    return this._started;
  }

  // -----------------------------------------------------------------------
  // Request / Notification
  // -----------------------------------------------------------------------

  /**
   * Send a JSON-RPC request via POST and return the result.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<any>} The result field from the JSON-RPC response
   */
  async request(method, params, timeoutMs) {
    const id = this._nextId++;
    const body = JSON.stringify(createRequest(id, method, params));

    const effectiveTimeout = timeoutMs ?? this._timeout;
    const json = await this._post(this._endpointUrl, body, effectiveTimeout);

    if (json && typeof json === "object" && "result" in json) {
      return json.result;
    }

    if (json && typeof json === "object" && "error" in json) {
      const err = new Error(
        json.error.message || `JSON-RPC error ${json.error.code}`,
      );
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }

    throw new Error("Unexpected JSON-RPC response");
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<void>}
   */
  async sendNotification(method, params) {
    const body = JSON.stringify(createNotification(method, params));
    await this._post(this._endpointUrl, body, this._timeout);
  }

  // -----------------------------------------------------------------------
  // Convenience
  // -----------------------------------------------------------------------

  /**
   * List tools exposed by the server.
   *
   * @returns {Promise<Array>}
   */
  async listTools() {
    const result = await this.request("tools/list", {});
    return result.tools || [];
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  /**
   * Store an access token for bearer authentication.
   * Subsequent requests will include an Authorization header.
   *
   * @param {string} token
   */
  setAccessToken(token) {
    this._accessToken = token;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Build the merged headers object for outgoing HTTP requests.
   * config.headers are overridden by the Authorization header when a token is set.
   *
   * @returns {object}
   */
  _headers() {
    const h = { ...(this.config.headers || {}) };
    if (this._accessToken) {
      h["Authorization"] = `Bearer ${this._accessToken}`;
    }
    return h;
  }

  /**
   * POST a JSON body to a URL and parse the JSON response.
   *
   * @param {string} urlStr
   * @param {string} body
   * @param {number} timeoutMs
   * @param {boolean} [_isRetry=false]  Internal — prevents infinite refresh loops
   * @returns {Promise<any>} Parsed JSON response body
   */
  async _post(urlStr, body, timeoutMs, _isRetry = false) {
    const postUrl = new URL(urlStr);
    const postModule = postUrl.protocol === "https:" ? https : http;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const response = await new Promise((resolve, reject) => {
        const req = postModule.request(
          urlStr,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...this._headers(),
            },
            signal: ac.signal,
            agent: this._agent,
          },
          (res) => resolve(res),
        );
        req.on("error", (err) => reject(err));
        req.write(body);
        req.end();
      });

      const chunks = [];
      for await (const chunk of response) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf-8");

      // Check for 401 — attempt automatic token refresh
      if (response.statusCode === 401) {
        if (!_isRetry && this.serverName) {
          const newToken = await refreshTokenIfNeeded(this.serverName);
          if (newToken) {
            this._accessToken = newToken;
            return this._post(urlStr, body, timeoutMs, true);
          }
        }
        throw new Error("OAuth token expired");
      }

      if (!response.statusCode || response.statusCode >= 400) {
        let errorData;
        try {
          errorData = JSON.parse(raw);
        } catch {
          errorData = raw;
        }
        const err = new Error(
          typeof errorData === "object" && errorData.message
            ? errorData.message
            : `HTTP ${response.statusCode}`,
        );
        err.statusCode = response.statusCode;
        err.body = errorData;
        throw err;
      }

      if (!raw || raw.trim().length === 0) {
        return null; // notification-style POST — no body
      }

      // The response may be SSE-framed (event + data lines). Parse it.
      const json = parseJsonOrSse(raw);

      // Auto-refresh when the upstream signals an expired OAuth token in the
      // JSON-RPC error body (HTTP 200 with a descriptive message — the gateway
      // reuses -32603 "Internal error" without a dedicated error code).
      if (
        json &&
        typeof json === "object" &&
        !_isRetry &&
        this.serverName &&
        json.error &&
        typeof json.error.message === "string" &&
        /\b(?:token.*expired|expired.*token)\b/i.test(json.error.message)
      ) {
        const newToken = await refreshTokenIfNeeded(this.serverName);
        if (newToken) {
          this._accessToken = newToken;
          return this._post(urlStr, body, timeoutMs, true);
        }
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parse a response body that may be plain JSON or SSE-framed.
 * SSE format: "event: message\ndata: {...json...}\n\n"
 */
function parseJsonOrSse(raw) {
  const trimmed = raw.trim();

  // Try plain JSON first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not plain JSON — try SSE framing
  }

  // Parse SSE events: split on double newline, then extract data: lines
  const events = trimmed.split(/\r?\n\r?\n/);
  for (const event of events) {
    let data = null;
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        data = line.slice("data: ".length).trim();
      }
    }
    if (data) {
      try {
        return JSON.parse(data);
      } catch {
        // keep looking
      }
    }
  }

  throw new Error(`Unexpected response format: ${trimmed.slice(0, 200)}`);
}
