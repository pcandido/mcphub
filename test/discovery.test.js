// Tests for OAuth metadata discovery — resource scopes (RFC 9728)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { discoverOAuthMetadata } from "../src/oauth/discovery.js";

// Scopes the protected resource requires, as announced in its metadata and in
// the 401 challenge: the extra permission never appears in the authorization
// server's own (generic) scopes_supported — the shape of a resource-scoped
// deployment such as an MCP server behind a shared gateway.
const RESOURCE_SCOPES = ["openid", "profile", "email", "mcp_rap_permission"];
const SERVER_SCOPES = ["openid", "profile", "email"];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorizationServerMetadata(origin) {
  return {
    issuer: `${origin}/`,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: SERVER_SCOPES,
  };
}

/**
 * Minimal gateway: the resource lives at /mcp, the authorization server at the
 * origin. Every route can be turned off to exercise the fallback chain.
 */
function startServer(opts = {}) {
  const {
    resourceScopes = RESOURCE_SCOPES,
    protectedResource = true,     // GET /.well-known/oauth-protected-resource/mcp
    perPathAuthWellKnown = false, // GET /mcp/.well-known/oauth-authorization-server
    headerChallenge = true,       // POST /mcp answers 401 with resource_metadata
  } = opts;
  const state = { requests: [] };

  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = new URL(req.url, origin).pathname;
    state.requests.push(`${req.method} ${path}`);

    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp" && protectedResource) {
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: resourceScopes,
        bearer_methods_supported: ["header"],
      });
    }

    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, authorizationServerMetadata(origin));
    }

    if (req.method === "GET" && path === "/mcp/.well-known/oauth-authorization-server" && perPathAuthWellKnown) {
      return json(res, 200, authorizationServerMetadata(origin));
    }

    if (req.method === "GET" && path === "/resource-meta") {
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: resourceScopes,
      });
    }

    if (req.method === "POST" && path === "/mcp" && headerChallenge) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          `Bearer error="invalid_token", scope="${resourceScopes.join(" ")}", ` +
          `resource_metadata="${origin}/resource-meta"`,
      });
      return res.end(JSON.stringify({ error: "invalid_token" }));
    }

    return json(res, 404, { detail: "Not Found" });
  });

  return { server, state };
}

async function withServer(opts, fn) {
  const { server, state } = startServer(opts);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    return await fn(baseUrl, state);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe("discoverOAuthMetadata", () => {
  it("reports the scopes the protected resource requires", async () => {
    await withServer({}, async (baseUrl) => {
      const metadata = await discoverOAuthMetadata(baseUrl);

      assert.deepEqual(metadata.resource_scopes, RESOURCE_SCOPES);
      assert.match(metadata.authorization_url, /\/authorize$/);
      assert.match(metadata.token_url, /\/token$/);
      assert.match(metadata.registration_endpoint, /\/register$/);
    });
  });

  it("never carries the authorization server's own scopes across", async () => {
    await withServer({}, async (baseUrl) => {
      const metadata = await discoverOAuthMetadata(baseUrl);

      assert.equal(metadata.scopes_supported, undefined);
      assert.deepEqual(metadata.resource_scopes, RESOURCE_SCOPES);
    });
  });

  it("reads the resource metadata from its well-known path without probing the server", async () => {
    await withServer({}, async (baseUrl, state) => {
      await discoverOAuthMetadata(baseUrl);

      assert.ok(state.requests.includes("GET /.well-known/oauth-protected-resource/mcp"));
      assert.ok(!state.requests.some((request) => request.startsWith("POST")));
    });
  });

  it("still reports the resource scopes when the path-level server metadata wins", async () => {
    await withServer({ perPathAuthWellKnown: true }, async (baseUrl, state) => {
      const metadata = await discoverOAuthMetadata(baseUrl);

      assert.ok(state.requests.includes("GET /mcp/.well-known/oauth-authorization-server"));
      assert.deepEqual(metadata.resource_scopes, RESOURCE_SCOPES);
    });
  });

  it("falls back to the WWW-Authenticate resource metadata when the well-known lookups fail", async () => {
    await withServer({ protectedResource: false }, async (baseUrl, state) => {
      const metadata = await discoverOAuthMetadata(baseUrl);

      assert.ok(state.requests.includes("POST /mcp"));
      assert.ok(state.requests.includes("GET /resource-meta"));
      assert.deepEqual(metadata.resource_scopes, RESOURCE_SCOPES);
    });
  });

  it("reports no scopes when only the authorization server advertises any", async () => {
    await withServer({ resourceScopes: [] }, async (baseUrl) => {
      const metadata = await discoverOAuthMetadata(baseUrl);

      assert.deepEqual(metadata.resource_scopes, undefined);
      assert.equal(metadata.scopes_supported, undefined);
    });
  });

  it("returns null when nothing answers", async () => {
    await withServer({ protectedResource: false, headerChallenge: false }, async (baseUrl) => {
      assert.equal(await discoverOAuthMetadata(baseUrl), null);
    });
  });
});
