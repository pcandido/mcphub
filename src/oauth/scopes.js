// Scope helpers shared by OAuth discovery and the auth command.
//
// One rule governs both: the authorization request carries the scope set the
// RESOURCE requires — never the authorization server's own `scopes_supported`,
// which lists the provider's scopes (openid, profile, email) rather than the
// resource's. A resource-scoped value the request omits (e.g.
// `mcp_rap_permission`) makes the server reject the token as `invalid_token`,
// which is indistinguishable from an expired one. The resource's list only
// became reachable with the RFC 9728 lookup — before that, omitting the
// parameter entirely was the right call (the server's list has always been
// wrong for this purpose).

/**
 * Split any accepted scope shape into a de-duplicated list of values.
 * Accepts "a b", "a,b", an array, or nothing.
 *
 * @param {string|string[]|null|undefined} scopes
 * @returns {string[]} e.g. ["openid", "profile"]
 */
export function toScopeList(scopes) {
  if (!scopes) return [];

  const list = Array.isArray(scopes) ? scopes : String(scopes).split(/[\s,]+/);
  return [...new Set(list.map((scope) => String(scope).trim()).filter(Boolean))];
}

/**
 * Space-separated form, as the OAuth `scope` parameter wants it.
 *
 * @param {string|string[]|null|undefined} scopes
 * @returns {string}
 */
export function normalizeScopes(scopes) {
  return toScopeList(scopes).join(' ');
}

/**
 * Scopes to request in the authorization request.
 * An explicit `--scopes` flag wins; otherwise the scopes the resource declares;
 * otherwise "" — the parameter is omitted and the server applies its defaults
 * (an empty `scope` is rejected by some providers).
 *
 * @param {string|string[]|null|undefined} flagScopes - value of the --scopes flag
 * @param {{resource_scopes?: string[]}|null} [discovered] - discovered metadata
 * @returns {string}
 */
export function resolveRequestedScopes(flagScopes, discovered) {
  const flagged = normalizeScopes(flagScopes);
  if (flagged) return flagged;
  return normalizeScopes(discovered && discovered.resource_scopes);
}
