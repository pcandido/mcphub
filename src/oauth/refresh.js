import https from 'node:https';
import http from 'node:http';
import { get, set } from '../keychain/index.js';

// Why the last refresh of each server failed. The `null` return of
// refreshTokenIfNeeded says "it did not work" — this keeps the token endpoint's
// own explanation (`error`, `error_description`), which is the difference
// between an expired token, a revoked one and one minted without the scope the
// resource requires.
const _lastFailures = new Map();

/**
 * @param {string} serverName
 * @returns {string} the last refresh failure for this server, or '' when the
 *   last refresh succeeded (or none was attempted)
 */
export function lastRefreshError(serverName) {
  return _lastFailures.get(serverName) || '';
}

/**
 * Turn a failed token-endpoint response into a one-line reason.
 * Pure — the plumbing that stores it is not testable without a keychain.
 *
 * @param {string} body - response body
 * @param {number} [statusCode]
 * @returns {string}
 */
export function tokenEndpointFailureReason(body, statusCode) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      detail = parsed.error_description || parsed.error || '';
    }
  } catch {
    // not JSON — fall through to the status code
  }

  if (detail) return detail;
  if (statusCode) return `token endpoint returned HTTP ${statusCode}`;
  return 'token endpoint request failed';
}

/**
 * Returns the current valid access_token for the given server,
 * refreshing it if expired or about to expire (within 30 seconds).
 * Returns null if no secret is stored or the refresh fails.
 *
 * @param {string} serverName
 * @returns {Promise<string|null>}
 */
export async function refreshTokenIfNeeded(serverName) {
  _lastFailures.delete(serverName);

  const secret = await get(serverName);
  if (!secret) {
    return null;
  }

  const now = Date.now();
  const expiresAt = new Date(secret.expires_at).getTime();
  if (now < expiresAt - 30_000) {
    return secret.access_token;
  }

  // Token expired or expiring — attempt refresh
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', secret.refresh_token);
  params.append('client_id', secret.client_id);

  // RFC 8707: include resource indicator if stored
  if (secret.resource_url) {
    params.append('resource', secret.resource_url);
  }

  const body = params.toString();

  const url = new URL(secret.token_url);
  const mod = url.protocol === 'https:' ? https : http;

  const agent = url.protocol === 'https:' && secret.insecure
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  const result = await new Promise((resolve) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        agent,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            _lastFailures.set(serverName, tokenEndpointFailureReason(data, res.statusCode));
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      _lastFailures.set(serverName, tokenEndpointFailureReason('', 0));
      resolve(null);
    });
    req.on('error', () => {
      _lastFailures.set(serverName, tokenEndpointFailureReason('', 0));
      resolve(null);
    });
    req.setTimeout(10_000);
    req.write(body);
    req.end();
  });

  if (!result) return null;

  let payload;
  try {
    payload = JSON.parse(result);
  } catch {
    console.warn('[oauth] Token refresh returned non-JSON response');
    _lastFailures.set(serverName, 'token endpoint returned a non-JSON response');
    return null;
  }

  const updatedSecret = {
    ...secret,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || secret.refresh_token,
    expires_at: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    refresh_expires_at: payload.refresh_token_expires_in
      ? new Date(Date.now() + payload.refresh_token_expires_in * 1000).toISOString()
      : secret.refresh_expires_at,
  };

  try {
    await set(serverName, updatedSecret);
  } catch (err) {
    console.warn('[oauth] Failed to persist refreshed token:', err.message);
    _lastFailures.set(serverName, `could not store the refreshed token: ${err.message}`);
    return null;
  }

  return updatedSecret.access_token;
}
