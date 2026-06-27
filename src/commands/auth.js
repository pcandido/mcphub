import https from 'node:https';
import http from 'node:http';

import { loadConfig } from '../config/loader.js';
import { writeConfig } from '../config/writer.js';
import { get as keychainGet, set as keychainSet } from '../keychain/index.js';
import { refreshTokenIfNeeded } from '../oauth/refresh.js';
import { discoverOAuthMetadata } from '../oauth/discovery.js';
import { runOAuthFlow, pickFreePort } from '../oauth/flow.js';

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
  const serverName = positional[0];
  const force = !!flags.force;
  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : null;
  const scopes = typeof flags['scopes'] === 'string' ? flags['scopes'] : null;

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
    await authenticate(config, serverName, server, { force, clientId, scopes });
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
      await authenticate(config, name, server, { force, clientId, scopes });
      console.log('');
    }
    console.log('Done.');
  }

  process.exit(0);
}

/**
 * Authenticate a single server.
 * Fully automatic: discovery → saved client_id or auto-register → OAuth PKCE.
 */
async function authenticate(config, serverName, server, { force, clientId, scopes }) {
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

      // Reuse saved client_id if available
      if (!clientId && secret.client_id) {
        clientId = secret.client_id;
        console.log(`  Using saved client_id (${clientId}).`);
      }
    } else {
      console.log('  No token found — starting OAuth flow...');
    }
  } else {
    console.log('  --force: re-authenticating...');
    // Reuse saved client_id on force too
    const secret = await keychainGet(serverName);
    if (!clientId && secret?.client_id) {
      clientId = secret.client_id;
      console.log(`  Using saved client_id (${clientId}).`);
    }
  }

  // 1. Discover OAuth metadata
  const discovered = await discoverOAuthMetadata(server.url, {
    insecure: server.insecure,
  });
  if (!discovered) {
    console.error('  ❌ OAuth metadata discovery failed.');
    return;
  }
  console.log('  Metadata discovered.');

  if (!discovered.authorization_url || !discovered.token_url) {
    console.error('  ❌ Authorization or token endpoint not found in server metadata.');
    return;
  }

  // 2. Probe a callback port (same port used in DCR and OAuth flow)
  const port = await pickFreePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 3. Resolve client_id: flag > saved > auto-register > error
  if (!clientId && discovered.registration_endpoint) {
    try {
      const reg = await registerClient(discovered.registration_endpoint, redirectUri, server.insecure);
      if (reg) {
        clientId = reg.client_id;
        console.log(`  Client registered (${clientId}).`);
        // Save client_id immediately so we don't re-register
        const existing = await keychainGet(serverName) || {};
        await keychainSet(serverName, {
          authorization_url: discovered.authorization_url,
          token_url: discovered.token_url,
          client_id: clientId,
        });
      }
    } catch (err) {
      console.log(`  Dynamic registration error: ${err.message}`);
    }
  }

  if (!clientId) {
    if (discovered.registration_endpoint) {
      console.error('  ❌ Dynamic client registration failed. Try: mcphub auth ' + serverName + ' --client-id=<id>');
    } else {
      console.error('  ❌ No registration endpoint found. Provide client_id with: mcphub auth ' + serverName + ' --client-id=<id>');
    }
    return;
  }

  // 4. Run OAuth flow
  try {
    await runOAuthFlow(serverName, {
      authorization_url: discovered.authorization_url,
      token_url: discovered.token_url,
      client_id: clientId,
      scopes: scopes || '',
      resource_url: server.url,
      port,
      insecure: server.insecure,
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
function registerClient(registrationEndpoint, redirectUri, insecure) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      client_name: 'mcphub',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    const url = new URL(registrationEndpoint);
    const transport = url.protocol === 'https:' ? https : http;
    const agent = url.protocol === 'https:' && insecure
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

    const req = transport.request(
      url.href,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'mcphub/0.3.1',
        },
        timeout: 10000,
        agent,
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
