// Tests for the token-refresh failure reasons
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastRefreshError, tokenEndpointFailureReason } from "../src/oauth/refresh.js";

describe("tokenEndpointFailureReason", () => {
  it("prefers the token endpoint's own description", () => {
    assert.equal(
      tokenEndpointFailureReason(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token is expired or revoked",
        }),
        400,
      ),
      "Refresh token is expired or revoked",
    );
  });

  it("falls back to the OAuth error code", () => {
    assert.equal(
      tokenEndpointFailureReason(JSON.stringify({ error: "invalid_scope" }), 400),
      "invalid_scope",
    );
  });

  it("falls back to the status code when the body says nothing", () => {
    assert.equal(tokenEndpointFailureReason("<html>Bad Gateway</html>", 502), "token endpoint returned HTTP 502");
    assert.equal(tokenEndpointFailureReason("", 401), "token endpoint returned HTTP 401");
  });

  it("describes a request that never got an answer", () => {
    assert.equal(tokenEndpointFailureReason("", 0), "token endpoint request failed");
  });
});

describe("lastRefreshError", () => {
  it("is empty for a server whose refresh never failed", () => {
    assert.equal(lastRefreshError("never-refreshed"), "");
  });
});
