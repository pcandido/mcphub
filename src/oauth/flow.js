// Authorization Code Flow with PKCE

import http from 'node:http';
import https from 'node:https';
import { exec } from 'node:child_process';
import { URLSearchParams } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';
import { set as keychainSet } from '../keychain/index.js';
import { discoverOAuthMetadata } from './discovery.js';

/**
 * Run the full OAuth Authorization Code flow with PKCE.
 *
 * @param {string} serverName - Friendly name for the server (used as keychain key)
 * @param {Object} [metadata] - Pre-discovered metadata; if missing, prompt interactively
 * @param {string} metadata.authorization_url
 * @param {string} metadata.token_url
 * @param {string} metadata.client_id
 * @param {string|string[]} [metadata.scopes]
 * @returns {Promise<Object>} The saved keychain entry
 */
export async function runOAuthFlow(serverName, metadata) {
  return _runOAuthFlow(serverName, metadata);
}

/**
 * Pick a free port in a high range (10240-10249).
 * @returns {Promise<number>}
 */
export async function pickFreePort() {
  return _pickFreePort();
}

async function _runOAuthFlow(serverName, metadata) {
  // Step 1: Resolve metadata (prompt if not provided)
  let authorizationUrl, tokenUrl, clientId, scopes;

  if (metadata) {
    authorizationUrl = metadata.authorization_url;
    tokenUrl = metadata.token_url;
    clientId = metadata.client_id;
    scopes = metadata.scopes || '';
  } else {
    const rl = readline.createInterface({ input, output });

    try {
      authorizationUrl = (await rl.question('Authorization URL: ')).trim();
      tokenUrl = (await rl.question('Token URL: ')).trim();
      clientId = (await rl.question('Client ID: ')).trim();
      const scopesRaw = (await rl.question('Scopes (comma-separated): ')).trim();
      scopes = scopesRaw;
    } finally {
      rl.close();
    }
  }

  if (!authorizationUrl || !tokenUrl || !clientId) {
    throw new Error('Authorization URL, Token URL, and Client ID are required');
  }

  // Normalize scopes to a space-separated string
  if (Array.isArray(scopes)) {
    scopes = scopes.join(' ');
  }

  // Step 2: Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Step 3: Start local HTTP server on a fixed high port
  const port = metadata?.port || await _pickFreePort();
  const { authCodePromise } = await startCallbackServer(state, port);

  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Step 4: Build authorization URL
  const authParams = new URLSearchParams();
  authParams.set('response_type', 'code');
  authParams.set('client_id', clientId);
  authParams.set('code_challenge', codeChallenge);
  authParams.set('code_challenge_method', 'S256');
  authParams.set('redirect_uri', redirectUri);
  if (scopes) {
    authParams.set('scope', scopes);
  }
  authParams.set('state', state);

  const authUrl = `${authorizationUrl}?${authParams.toString()}`;

  // Step 5: Open browser
  openBrowser(authUrl);

  // Step 6: Wait for callback
  const timeoutMs = 120000;
  const code = await Promise.race([
    authCodePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OAuth callback timed out after 120 seconds')), timeoutMs)
    ),
  ]);

  // Step 7: Exchange code for tokens
  const tokenBody = new URLSearchParams();
  tokenBody.set('grant_type', 'authorization_code');
  tokenBody.set('code', code);
  tokenBody.set('code_verifier', codeVerifier);
  tokenBody.set('redirect_uri', redirectUri);
  tokenBody.set('client_id', clientId);

  const tokenResponse = await postForm(tokenUrl, tokenBody);

  if (!tokenResponse || tokenResponse.error) {
    const errMsg = tokenResponse?.error_description || tokenResponse?.error || 'Token exchange failed';
    throw new Error(errMsg);
  }

  const { access_token, refresh_token, expires_in } = tokenResponse;

  // Step 9: Compute expires_at
  const expiresAt = expires_in
    ? new Date(Date.now() + expires_in * 1000).toISOString()
    : undefined;

  // Step 10: Save to keychain
  /** @type {Object} */
  const entry = {
    authorization_url: authorizationUrl,
    token_url: tokenUrl,
    client_id: clientId,
    scopes,
    access_token,
    refresh_token: refresh_token || null,
    expires_at: expiresAt || null,
  };

  await keychainSet(serverName, entry);

  return entry;
}

/**
 * Start a local HTTP callback server on 127.0.0.1 at the given port.
 * Returns a promise that resolves with the authorization code.
 *
 * @param {string} expectedState
 * @param {number} port
 * @returns {Promise<{ authCodePromise: Promise<string> }>}
 */
function startCallbackServer(expectedState, port) {
  return new Promise((resolveStart, rejectStart) => {
    const server = http.createServer();

    const authCodePromise = new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          if (url.pathname !== '/callback') {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const params = url.searchParams;
          const code = params.get('code');
          const returnedState = params.get('state');
          const error = params.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(page('Authorization failed', `<p>${error}</p>`, 'error'));
            server.close();
            return reject(new Error(`OAuth error: ${error}`));
          }

          if (returnedState !== expectedState) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(page('Session expired', '<p>The authorization session is no longer valid. Please try again.</p>', 'error'));
            server.close();
            return reject(new Error('OAuth state mismatch — possible CSRF attack'));
          }

          if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(page('Missing code', '<p>No authorization code received. Please try again.</p>', 'error'));
            server.close();
            return reject(new Error('No authorization code received'));
          }

          // Success — try to close, fallback to friendly message
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><title>gtwmcp — done</title>
<style>
  * { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; justify-content: center; align-items: center;
    height: 100vh; background: #0d0d0d; color: #e5e5e5; }
  .card { text-align: center; max-width: 360px; }
  h1 { font-size: 1.5rem; color: #16a34a; margin-bottom: .5rem; }
  p { font-size: .75rem; color: #525252; margin-top: 1rem; }
</style></head>
<body><div class="card">
  <h1>Authorization complete</h1>
  <p>You can close this window.</p>
</div></body>
<script>close()</script>
</html>`);

          server.close();
          resolve(code);
        } catch (err) {
          server.close();
          reject(err);
        }
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolveStart({ authCodePromise });
    });

    server.on('error', (err) => {
      rejectStart(err);
    });
  });
}

/**
 * Pick a free port in a high range (10240-10249).
 * Returns the first available port, or throws if all are busy.
 */
async function _pickFreePort() {
  for (let port = 10240; port <= 10249; port++) {
    const free = await probePort(port);
    if (free) return port;
  }
  throw new Error('No free callback port in range 10240-10249');
}

/**
 * Probe whether a port is available on 127.0.0.1.
 */
function probePort(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

/**
 * Render an HTML page that auto-closes after 3 seconds with a countdown.
 */
function page(title, body, kind) {
  const color = kind === 'ok' ? '#16a34a' : '#dc2626';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>gtwmcp — ${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; justify-content: center; align-items: center;
    height: 100vh; background: #0d0d0d; color: #e5e5e5;
  }
  .card { text-align: center; max-width: 360px; }
  h1 { font-size: 1.5rem; color: ${color}; margin-bottom: .5rem; }
  p { font-size: .875rem; color: #a3a3a3; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  ${body}
  <p style="margin-top:1.5rem;font-size:.75rem;color:#525252">You can close this window.</p>
</div>
</body>
</html>`;
}

/**
 * Open a URL in the default browser.
 */
function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error(`Failed to open browser: ${err.message}`);
      console.error(`Please open this URL manually:\n${url}`);
    }
  });
}

/**
 * POST form-urlencoded data and parse the JSON response.
 */
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const postData = body.toString();

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    };

    const req = transport.request(options, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          resolve(JSON.parse(responseBody));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Token request timed out')); });

    req.write(postData);
    req.end();
  });
}
