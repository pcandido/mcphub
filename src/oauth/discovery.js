// OAuth server metadata discovery via .well-known endpoints + WWW-Authenticate fallback

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * @typedef {Object} OAuthMetadata
 * @property {string} authorization_url
 * @property {string} token_url
 * @property {string} [registration_endpoint]
 * @property {string[]} [scopes_supported]
 */

/**
 * Discover OAuth server metadata from a server URL.
 * Best-effort — returns null on any failure.
 *
 * Three strategies, tried in order:
 *   1. GET <serverUrl>.well-known/oauth-authorization-server (path-level)
 *   2. GET <origin>/.well-known/oauth-protected-resource → follow auth_server
 *   3. POST <serverUrl> (no auth) → read resource_metadata from WWW-Authenticate header
 *
 * @param {string} serverUrl - The MCP server URL (e.g. https://example.com/mcp)
 * @returns {Promise<OAuthMetadata|null>}
 */
export async function discoverOAuthMetadata(serverUrl) {
  // Strategy 1: path-level .well-known (server-relative)
  let metadata = await discoverViaPathWellKnown(serverUrl);
  if (metadata) return metadata;

  // Strategy 2: root-level .well-known
  metadata = await discoverViaRootWellKnown(serverUrl);
  if (metadata) return metadata;

  // Strategy 3: POST to server, read WWW-Authenticate 401 header
  metadata = await discoverViaWwwAuthenticate(serverUrl);
  if (metadata) return metadata;

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 1: GET <serverUrl>.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------

async function discoverViaPathWellKnown(serverUrl) {
  try {
    // Normalize trailing slash: serverUrl/ + .well-known/oauth-authorization-server
    const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    const metadataUrl = `${base}.well-known/oauth-authorization-server`;
    const authMetadata = await fetchJSON(metadataUrl);
    if (!authMetadata) return null;
    return buildMetadata(authMetadata);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: GET <origin>/.well-known/oauth-protected-resource → follow auth_server
// ---------------------------------------------------------------------------

async function discoverViaRootWellKnown(serverUrl) {
  try {
    const origin = getOrigin(serverUrl);
    if (!origin) return null;

    const protectedResource = await fetchJSON(`${origin}/.well-known/oauth-protected-resource`);
    if (!protectedResource) return null;

    const authServer = protectedResource.authorization_server;
    if (!authServer) return null;

    const authServerUrl = resolveUrl(authServer, origin);
    const authMetadata = await fetchJSON(`${authServerUrl}/.well-known/oauth-authorization-server`);
    if (!authMetadata) return null;

    return buildMetadata(authMetadata);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: POST to server → read WWW-Authenticate → resource_metadata
// ---------------------------------------------------------------------------

async function discoverViaWwwAuthenticate(serverUrl) {
  try {
    // Send a minimal POST (no auth) to trigger a 401 with WWW-Authenticate
    const response = await postJson(serverUrl, JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcphub', version: '0.1.0' },
      },
    }));

    if (response.statusCode !== 401) return null;

    const wwwAuth = response.headers['www-authenticate'];
    if (!wwwAuth) return null;

    const resourceMetaUrl = parseWwwAuthenticateParam(wwwAuth, 'resource_metadata');
    if (!resourceMetaUrl) return null;

    // Fetch the resource metadata
    const resourceMeta = await fetchJSON(resourceMetaUrl);
    if (!resourceMeta) return null;

    // Get the authorization server URL
    const authServers = resourceMeta.authorization_servers;
    if (!authServers || !Array.isArray(authServers) || authServers.length === 0) return null;

    const authServerUrl = authServers[0];
    // .well-known is always at the origin root — strip any path from authServerUrl
    const authOrigin = getOrigin(authServerUrl) || authServerUrl;
    const authMetadata = await fetchJSON(`${authOrigin}/.well-known/oauth-authorization-server`);
    if (!authMetadata) return null;

    return buildMetadata(authMetadata);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMetadata(authMetadata) {
  /** @type {OAuthMetadata} */
  const result = {
    authorization_url: authMetadata.authorization_endpoint,
    token_url: authMetadata.token_endpoint,
  };

  if (authMetadata.scopes_supported) {
    result.scopes_supported = authMetadata.scopes_supported;
  }
  if (authMetadata.registration_endpoint) {
    result.registration_endpoint = authMetadata.registration_endpoint;
  }
  if (authMetadata.resource_parameter_supported) {
    result.resource_parameter_supported = true;
  }

  // Validate required fields
  if (!result.authorization_url || !result.token_url) return null;

  return result;
}

/**
 * Extract origin (scheme + host + port) from a URL string.
 */
function getOrigin(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Resolve a potentially-relative URL against an origin base.
 */
function resolveUrl(candidate, base) {
  try {
    return new URL(candidate, base).origin;
  } catch {
    return candidate;
  }
}

/**
 * Fetch and parse JSON from a URL. Returns null on any failure.
 */
function fetchJSON(url) {
  return new Promise((resolve) => {
    const transport = url.startsWith('https:') ? https : http;

    const req = transport.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.destroy();
        return resolve(null);
      }

      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * POST JSON to a URL and return the full response (status, headers, body).
 */
function postJson(urlStr, body) {
  return new Promise((resolve) => {
    const postUrl = new URL(urlStr);
    const transport = postUrl.protocol === 'https:' ? https : http;

    const req = transport.request(
      urlStr,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });

    req.write(body);
    req.end();
  });
}

/**
 * Parse a quoted parameter value from a WWW-Authenticate header.
 * e.g. resource_metadata="https://..." → https://...
 */
function parseWwwAuthenticateParam(header, paramName) {
  const regex = new RegExp(`${paramName}\\s*=\\s*"([^"]+)"`, 'i');
  const match = header.match(regex);
  return match ? match[1] : null;
}
