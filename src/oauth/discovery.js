// OAuth server metadata discovery via .well-known endpoints + WWW-Authenticate fallback

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { toScopeList } from './scopes.js';

/**
 * @typedef {Object} OAuthMetadata
 * @property {string} authorization_url
 * @property {string} token_url
 * @property {string} [registration_endpoint]
 * @property {boolean} [resource_parameter_supported]
 * @property {string[]} [resource_scopes] - scopes the protected resource
 *   requires (RFC 9728), which is what the authorization request asks for
 */

/**
 * Discover OAuth server metadata from a server URL.
 * Best-effort — returns null on any failure.
 *
 * Three strategies for the endpoints, tried in order:
 *   1. GET <serverUrl>.well-known/oauth-authorization-server (path-level)
 *   2. GET <origin>/.well-known/oauth-protected-resource → follow auth_server
 *   3. POST <serverUrl> (no auth) → read resource_metadata from WWW-Authenticate header
 *
 * Independently of those, the protected-resource metadata (RFC 9728) is fetched
 * for its scopes: it is the only document that lists the scopes THIS resource
 * requires, and it is the only scope source the authorization request uses. The
 * authorization server's own `scopes_supported` is generic — a resource-scoped
 * deployment answers 401 with `scope="… mcp_x_permission"` that never appears in
 * the server metadata, and a token minted without it is rejected as
 * `invalid_token`.
 *
 * @param {string} serverUrl - The MCP server URL (e.g. https://example.com/mcp)
 * @param {Object} [opts]
 * @param {boolean} [opts.insecure] - Bypass TLS certificate validation for the MCP server
 * @returns {Promise<OAuthMetadata|null>}
 */
export async function discoverOAuthMetadata(serverUrl, opts) {
  const insecure = !!(opts && opts.insecure);

  // Protected-resource metadata (RFC 9728) — best-effort, merged below into
  // whichever strategy discovers the endpoints.
  const protectedResource = await discoverProtectedResourceMetadata(serverUrl, insecure);
  let resourceMetadata = protectedResource;

  // Strategy 1: path-level .well-known (server-relative)
  let metadata = await discoverViaPathWellKnown(serverUrl, insecure);

  // Strategy 2: root-level .well-known
  if (!metadata) {
    metadata = await discoverViaRootWellKnown(serverUrl, insecure, protectedResource);
  }

  // Strategy 3: POST to server, read WWW-Authenticate 401 header
  if (!metadata) {
    const viaHeader = await discoverViaWwwAuthenticate(serverUrl, insecure);
    if (viaHeader) {
      metadata = viaHeader.metadata;
      resourceMetadata = resourceMetadata || viaHeader.protectedResource;
    }
  }

  if (!metadata) return null;

  return applyResourceScopes(metadata, resourceMetadata);
}

// ---------------------------------------------------------------------------
// Strategy 1: GET <serverUrl>.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------

async function discoverViaPathWellKnown(serverUrl, insecure) {
  try {
    // Normalize trailing slash: serverUrl/ + .well-known/oauth-authorization-server
    const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    const metadataUrl = `${base}.well-known/oauth-authorization-server`;
    const authMetadata = await fetchJSON(metadataUrl, insecure);
    if (!authMetadata) return null;
    return buildMetadata(authMetadata);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: GET <origin>/.well-known/oauth-protected-resource → follow auth_server
// ---------------------------------------------------------------------------

async function discoverViaRootWellKnown(serverUrl, insecure, knownProtectedResource) {
  try {
    const origin = getOrigin(serverUrl);
    if (!origin) return null;

    // The caller already fetched the protected-resource metadata for this URL
    // (per-path first, same document) — reuse it instead of a second GET.
    const protectedResource = knownProtectedResource
      || await fetchJSON(`${origin}/.well-known/oauth-protected-resource`, insecure);
    if (!protectedResource) return null;

    const authServer = protectedResource.authorization_servers;
    if (!authServer || !Array.isArray(authServer) || authServer.length === 0) return null;

    const authServerUrl = resolveUrl(authServer[0], origin);
    const authMetadata = await fetchJSON(`${authServerUrl}/.well-known/oauth-authorization-server`, insecure);
    if (!authMetadata) return null;

    return buildMetadata(authMetadata);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: POST to server → read WWW-Authenticate → resource_metadata
// ---------------------------------------------------------------------------

async function discoverViaWwwAuthenticate(serverUrl, insecure) {
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
    }), insecure);

    if (response.statusCode !== 401) return null;

    const wwwAuth = response.headers['www-authenticate'];
    if (!wwwAuth) return null;

    const resourceMetaUrl = parseWwwAuthenticateParam(wwwAuth, 'resource_metadata');
    if (!resourceMetaUrl) return null;

    // Fetch the resource metadata
    const resourceMeta = await fetchJSON(resourceMetaUrl, insecure);
    if (!resourceMeta) return null;

    // Get the authorization server URL
    const authServers = resourceMeta.authorization_servers;
    if (!authServers || !Array.isArray(authServers) || authServers.length === 0) return null;

    const authServerUrl = authServers[0];
    // .well-known is always at the origin root — strip any path from authServerUrl
    const authOrigin = getOrigin(authServerUrl) || authServerUrl;
    const authMetadata = await fetchJSON(`${authOrigin}/.well-known/oauth-authorization-server`, insecure);
    if (!authMetadata) return null;

    // Hand both documents back: the 401 header is often the only place the
    // protected-resource metadata (and therefore the resource scopes) is announced.
    return { metadata: buildMetadata(authMetadata), protectedResource: resourceMeta };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Protected-resource metadata (RFC 9728)
// ---------------------------------------------------------------------------

/**
 * Fetch the protected-resource metadata for a server URL.
 * The canonical location for a resource with a path is
 * `<origin>/.well-known/oauth-protected-resource<path>`; the bare origin form is
 * the fallback for deployments that publish a single document per host.
 *
 * @param {string} serverUrl
 * @param {boolean} [insecure]
 * @returns {Promise<Object|null>}
 */
async function discoverProtectedResourceMetadata(serverUrl, insecure) {
  const origin = getOrigin(serverUrl);
  if (!origin) return null;

  let path = '';
  try {
    path = new URL(serverUrl).pathname.replace(/\/+$/, '');
  } catch {
    // no path — the origin form below is the only option
  }

  if (path && path !== '/') {
    const perPath = await fetchJSON(`${origin}/.well-known/oauth-protected-resource${path}`, insecure);
    if (perPath) return perPath;
  }

  return fetchJSON(`${origin}/.well-known/oauth-protected-resource`, insecure);
}

/**
 * Apply the scopes the resource declares to the discovered metadata.
 * Returns the metadata untouched when the resource declares none — asking for
 * nothing is the correct fallback (see the Scopes section of the README).
 *
 * @param {OAuthMetadata} metadata
 * @param {Object|null} protectedResource
 * @returns {OAuthMetadata}
 */
function applyResourceScopes(metadata, protectedResource) {
  const scopes = toScopeList(protectedResource && protectedResource.scopes_supported);

  if (scopes.length > 0) {
    metadata.resource_scopes = scopes;
  }

  return metadata;
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

  // The server's own scopes_supported is deliberately NOT carried over: it
  // lists the provider's scopes (openid, profile, email), not what the resource
  // requires. Requesting it is what af18437 removed; resource_scopes (below)
  // replaces it with the document that actually knows.
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
 *
 * @param {string} url
 * @param {boolean} [insecure]
 */
function fetchJSON(url, insecure) {
  const agent = insecure && url.startsWith('https:')
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  return new Promise((resolve) => {
    const transport = url.startsWith('https:') ? https : http;

    const req = transport.get(url, { timeout: 10000, agent }, (res) => {
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
 *
 * @param {string} urlStr
 * @param {string} body
 * @param {boolean} [insecure]
 */
function postJson(urlStr, body, insecure) {
  const isHttps = urlStr.startsWith('https:');
  const agent = isHttps && insecure
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  return new Promise((resolve) => {
    const transport = isHttps ? https : http;

    const req = transport.request(
      urlStr,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
        agent,
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
