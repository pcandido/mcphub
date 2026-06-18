import https from 'node:https';
import http from 'node:http';

import { loadConfig } from '../config/loader.js';
import { writeConfig } from '../config/writer.js';
import { get as keychainGet } from '../keychain/index.js';
import { refreshTokenIfNeeded } from '../oauth/refresh.js';
import { discoverOAuthMetadata } from '../oauth/discovery.js';
import { runOAuthFlow } from '../oauth/flow.js';

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;

    const eqIdx = arg.indexOf('=');
    let key, value;
    if (eqIdx !== -1) {
      key = arg.slice(2, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else {
      key = arg.slice(2);
      value = true;
    }

    if (flags[key] !== undefined) {
      if (Array.isArray(flags[key])) {
        flags[key].push(value);
      } else {
        flags[key] = [flags[key], value];
      }
    } else {
      flags[key] = value;
    }
  }
  return flags;
}

export default async function authServer(args) {
  const flags = parseFlags(args);
  const positional = args.filter(a => !a.startsWith('--'));
  const serverName = positional[0]; // optional
  const force = !!flags.force;

  const config = await loadConfig();

  if (serverName) {
    const server = config.servers[serverName];
    if (!server) {
      console.error(`Server '${serverName}' not found.`);
      process.exit(1);
    }
    if (server.type !== 'sse') {
      console.error(`Server '${serverName}' is stdio — OAuth not applicable.`);
      process.exit(1);
    }
    await authenticate(config, serverName, server, force);
  } else {
    const sseServers = Object.entries(config.servers)
      .filter(([, s]) => s.type === 'sse');

    if (sseServers.length === 0) {
      console.log('No SSE servers configured.');
      process.exit(0);
    }

    console.log(`Authenticating ${sseServers.length} SSE server(s)...\n`);
    for (const [name, server] of sseServers) {
      console.log(`[${name}] ${server.url}`);
      await authenticate(config, name, server, force);
      console.log('');
    }
    console.log('Done.');
  }

  process.exit(0);
}

/**
 * Authenticate a single server.
 * Discovery + auto-registration only — no interactive prompts.
 */
async function authenticate(config, serverName, server, force) {
  // If not forced, check if we already have a valid token
  if (!force) {
    const secret = await keychainGet(serverName);
    if (secret) {
      const token = await refreshTokenIfNeeded(serverName);
      if (token) {
        const refreshed = await keychainGet(serverName);
        if (refreshed && refreshed.expires_at) {
          const remainingMs = new Date(refreshed.expires_at).getTime() - Date.now();
          console.log(`  ✅ Token valid (expires in ${Math.round(remainingMs / 60000)}m)`);
        } else {
          console.log('  ✅ Token valid');
        }
        return;
      }
      console.log('  ⚠️  Token refresh failed — starting OAuth flow...');
    } else {
      console.log('  No token found — starting OAuth flow...');
    }
  } else {
    console.log('  --force: re-authenticating...');
  }

  // 1. Discover OAuth metadata (authorization_url, token_url, registration_endpoint)
  const discovered = await discoverOAuthMetadata(server.url);
  if (!discovered) {
    console.error('  ❌ OAuth metadata discovery failed. Server does not expose .well-known or WWW-Authenticate metadata.');
    return;
  }
  console.log('  Metadata discovered.');

  if (!discovered.authorization_url || !discovered.token_url) {
    console.error('  ❌ Authorization or token endpoint not found in server metadata.');
    return;
  }

  // 2. Dynamic client registration
  let clientId = null;
  if (discovered.registration_endpoint) {
    try {
      const reg = await registerClient(discovered.registration_endpoint);
      if (reg) {
        clientId = reg.client_id;
        console.log(`  Client registered (${clientId}).`);
      }
    } catch (err) {
      console.log(`  Dynamic registration failed: ${err.message}`);
    }
  }

  if (!clientId) {
    console.error('  ❌ No registration endpoint in server metadata — cannot obtain client_id.');
    return;
  }

  // 3. Run OAuth flow
  try {
    await runOAuthFlow(serverName, {
      authorization_url: discovered.authorization_url,
      token_url: discovered.token_url,
      client_id: clientId,
      scopes: discovered.scopes_supported || '',
    });
    console.log('  ✅ Authenticated.');

    if (!server.oauth) {
      server.oauth = true;
      await writeConfig(config);
    }
  } catch (err) {
    console.error(`  ❌ OAuth flow failed: ${err.message}`);
  }
}

/**
 * Dynamic client registration (RFC 7591).
 */
function registerClient(registrationEndpoint) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      client_name: 'gtwmcp',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    const url = new URL(registrationEndpoint);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url.href,
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
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (data.client_id) {
              resolve({ client_id: data.client_id });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });

    req.write(body);
    req.end();
  });
}
