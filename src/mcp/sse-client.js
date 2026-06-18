// MCP SSE Client — HTTP-based transport that connects to an SSE endpoint
//
// Supports the Streamable HTTP transport from the MCP specification:
//   - Opens a GET connection to receive SSE events
//   - Sends JSON-RPC requests and notifications via POST to the endpoint URL
//   - Handles OAuth token management via an Authorization header

import { createRequest, createNotification } from "../mcp/protocol.js";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially-relative URL against a base origin.
 *
 * @param {string} candidate  The URL from the SSE endpoint event (may be relative)
 * @param {URL} origin         The original connection URL
 * @returns {string}           Absolute URL string
 */
function resolveEndpointUrl(candidate, origin) {
  if (!candidate) return origin.href;

  // Already absolute
  if (/^https?:\/\//i.test(candidate)) return candidate;

  // Relative — resolve against origin
  // Handles both "/path" and "path" forms
  if (candidate.startsWith("/")) {
    return `${origin.origin}${candidate}`;
  }
  return `${origin.origin}/${candidate}`;
}

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

    /** @type {AbortController|null} */
    this._ac = null;

    /** @type {string|null} */
    this._endpointUrl = null;

    /** @type {string|null} */
    this._accessToken = null;

    /** @type {number} */
    this._nextId = 1;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the SSE connection: open GET, parse events, discover the POST
   * endpoint, and send an initialize request.
   *
   * @returns {Promise<object>} initialize response
   */
  async start() {
    this._ac = new AbortController();
    const { signal } = this._ac;

    // Build GET headers
    const getHeaders = {
      Accept: "application/json, text/event-stream",
      ...this._headers(),
    };

    // Open SSE stream --------------------------------------------------
    const getModule = this.url.protocol === "https:" ? https : http;

    const response = await new Promise((resolve, reject) => {
      const req = getModule.get(
        this.url.href,
        { headers: getHeaders, signal },
        (res) => resolve(res),
      );
      req.on("error", (err) => reject(err));
    });

    // Read SSE stream to discover endpoint ------------------------------
    this._endpointUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        // No endpoint event within 5s — fall back to original URL
        resolve(null);
      }, 5000);

      response.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");

        // SSE events are separated by double newlines
        const parts = buffer.split(/\r?\n\r?\n/);
        // Keep the last incomplete part in the buffer
        buffer = parts.pop();

        for (const part of parts) {
          let eventType = null;
          let data = null;

          for (const line of part.split(/\r?\n/)) {
            if (line.startsWith("event: ")) {
              eventType = line.slice("event: ".length).trim();
            } else if (line.startsWith("data: ")) {
              data = line.slice("data: ".length).trim();
            }
          }

          if (eventType === "endpoint" && data) {
            clearTimeout(timer);
            resolve(data);
            return;
          }
        }
      });

      response.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Resolve endpoint URL ----------------------------------------------
    const postUrl = this._endpointUrl
      ? resolveEndpointUrl(this._endpointUrl, this.url)
      : this.url.href;

    this._endpointUrl = postUrl;

    // Send initialize request -------------------------------------------
    const initResponse = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "mcphub",
        version: "0.1.0",
      },
    });

    return initResponse;
  }

  /**
   * Stop the SSE connection and clean up.
   */
  stop() {
    if (this._ac) {
      this._ac.abort();
      this._ac = null;
    }
    this._endpointUrl = null;
  }

  /**
   * Whether the client has an active connection.
   *
   * @returns {boolean}
   */
  get running() {
    return this._ac !== null && !this._ac.signal.aborted;
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
  async request(method, params, timeoutMs = 30000) {
    const id = this._nextId++;
    const body = JSON.stringify(createRequest(id, method, params));

    const json = await this._post(this._endpointUrl, body, timeoutMs);

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
    await this._post(this._endpointUrl, body, 30000);
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
   * @returns {Promise<any>} Parsed JSON response body
   */
  async _post(urlStr, body, timeoutMs) {
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

      // Check for 401
      if (response.statusCode === 401) {
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
      return parseJsonOrSse(raw);
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
