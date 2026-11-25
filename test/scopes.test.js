// Tests for the scope helpers — resource-scoped OAuth
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScopes, resolveRequestedScopes, toScopeList } from "../src/oauth/scopes.js";

describe("toScopeList", () => {
  it("keeps an array as-is", () => {
    assert.deepEqual(toScopeList(["openid", "profile"]), ["openid", "profile"]);
  });

  it("accepts comma-separated values, as passed on the CLI flag", () => {
    assert.deepEqual(toScopeList("openid,profile,email"), ["openid", "profile", "email"]);
  });

  it("trims, drops empty values and de-duplicates", () => {
    assert.deepEqual(toScopeList(" openid  openid, profile "), ["openid", "profile"]);
  });

  it("returns an empty list for absent scopes", () => {
    assert.deepEqual(toScopeList(undefined), []);
    assert.deepEqual(toScopeList(null), []);
    assert.deepEqual(toScopeList(""), []);
    assert.deepEqual(toScopeList([]), []);
  });
});

describe("normalizeScopes", () => {
  it("joins the list into the space-separated form the scope parameter wants", () => {
    assert.equal(normalizeScopes(["openid", "profile", "email", "mcp_rap_permission"]), "openid profile email mcp_rap_permission");
  });

  it("returns an empty string for absent scopes", () => {
    assert.equal(normalizeScopes(undefined), "");
    assert.equal(normalizeScopes([]), "");
  });
});

describe("resolveRequestedScopes", () => {
  it("prefers the --scopes flag over what discovery found", () => {
    assert.equal(resolveRequestedScopes("custom", { resource_scopes: ["openid"] }), "custom");
    assert.equal(resolveRequestedScopes("a,b", { resource_scopes: ["openid"] }), "a b");
  });

  it("falls back to the scopes the resource declares", () => {
    assert.equal(
      resolveRequestedScopes(null, { resource_scopes: ["openid", "profile", "email", "mcp_rap_permission"] }),
      "openid profile email mcp_rap_permission",
    );
  });

  it("asks for nothing when the resource declares no scopes", () => {
    assert.equal(resolveRequestedScopes(null, {}), "");
    assert.equal(resolveRequestedScopes(null, undefined), "");
    assert.equal(resolveRequestedScopes(null, { resource_scopes: [] }), "");
  });
});
