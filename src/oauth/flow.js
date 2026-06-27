// Authorization Code Flow with PKCE

import http from 'node:http';
import https from 'node:https';
import { exec } from 'node:child_process';
import { URLSearchParams } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';
import { set as keychainSet } from '../keychain/index.js';

/**
 * Run the full OAuth Authorization Code flow with PKCE.
 *
 * @param {string} serverName - Friendly name for the server (used as keychain key)
 * @param {Object} [metadata] - Pre-discovered metadata; if missing, prompt interactively
 * @param {string} metadata.authorization_url
 * @param {string} metadata.token_url
 * @param {string} metadata.client_id
 * @param {string} [metadata.resource_url]     - RFC 8707 resource indicator (the MCP server URL)
 * @param {string|string[]} [metadata.scopes]
 * @param {number} [metadata.port]
 * @param {boolean} [metadata.insecure]        - Bypass TLS verification for token exchange
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
  // Step 1: Resolve metadata
  let authorizationUrl, tokenUrl, clientId, scopes, resourceUrl, insecure;

  if (metadata) {
    authorizationUrl = metadata.authorization_url;
    tokenUrl = metadata.token_url;
    clientId = metadata.client_id;
    scopes = metadata.scopes || '';
    resourceUrl = metadata.resource_url || null;
    insecure = !!metadata.insecure;
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

  // Normalize scopes
  if (Array.isArray(scopes)) scopes = scopes.join(' ');

  // Step 2: Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Step 3: Start local HTTP server
  const port = metadata?.port || await _pickFreePort();
  const { authCodePromise } = await startCallbackServer(port);

  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Step 4: Build authorization URL
  const authParams = new URLSearchParams();
  authParams.set('response_type', 'code');
  authParams.set('client_id', clientId);
  authParams.set('code_challenge', codeChallenge);
  authParams.set('code_challenge_method', 'S256');
  authParams.set('redirect_uri', redirectUri);
  if (scopes) authParams.set('scope', scopes);
  if (resourceUrl) authParams.set('resource', resourceUrl);
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
  if (resourceUrl) tokenBody.set('resource', resourceUrl);

  const tokenResponse = await postForm(tokenUrl, tokenBody, insecure);

  if (!tokenResponse || tokenResponse.error) {
    const errMsg = tokenResponse?.error_description || tokenResponse?.error || 'Token exchange failed';
    throw new Error(errMsg);
  }

  const { access_token, refresh_token, expires_in, refresh_token_expires_in } = tokenResponse;

  // Save to keychain
  const entry = {
    authorization_url: authorizationUrl,
    token_url: tokenUrl,
    client_id: clientId,
    scopes,
    access_token,
    refresh_token: refresh_token || null,
    expires_at: expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null,
    refresh_expires_at: refresh_token_expires_in
      ? new Date(Date.now() + refresh_token_expires_in * 1000).toISOString()
      : null,
  };

  if (resourceUrl) {
    entry.resource_url = resourceUrl;
  }
  if (insecure) {
    entry.insecure = true;
  }

  await keychainSet(serverName, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

function startCallbackServer(port) {
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
          const error = params.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(errorPage(error));
            server.close();
            return reject(new Error(`OAuth error: ${error}`));
          }

          if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(errorPage('No authorization code received.'));
            server.close();
            return reject(new Error('No authorization code received'));
          }

          // Success
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="background:#0d0d0d;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,sans-serif"><div style="text-align:center"><h1 style="color:#16a34a;font-size:1.5rem">Authorization complete</h1><p style="color:#525252;font-size:.75rem;margin-top:1rem">You can close this window.</p></div></body></html>');

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

function errorPage(msg) {
  return `<html><body style="background:#0d0d0d;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,sans-serif"><div style="text-align:center;max-width:360px"><h1 style="color:#dc2626;font-size:1.5rem;margin-bottom:.5rem">Authorization failed</h1><p style="color:#a3a3a3;font-size:.875rem;line-height:1.5">${msg}</p><p style="color:#525252;font-size:.75rem;margin-top:1.5rem">You can close this window.</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

async function _pickFreePort() {
  for (let port = 10240; port <= 10249; port++) {
    const free = await probePort(port);
    if (free) return port;
  }
  throw new Error('No free callback port in range 10240-10249');
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Browser & HTTP
// ---------------------------------------------------------------------------

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

function postForm(url, body, insecure) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const agent = parsed.protocol === 'https:' && insecure
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

    const postData = body.toString();

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
      agent,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
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
