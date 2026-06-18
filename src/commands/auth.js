import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

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
    // Single server mode — any SSE server is fair game
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
    // Bulk mode — all SSE servers
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
 * @param {object} config - Mutable config object (updated in-place)
 * @param {string} serverName
 * @param {object} server
 * @param {boolean} force - Re-authenticate even with a valid token
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

  // Discover OAuth metadata
  let oauthMeta = {};
  try {
    const discovered = await discoverOAuthMetadata(server.url);
    if (discovered) {
      oauthMeta = discovered;
      console.log('  OAuth metadata discovered via .well-known.');
    }
  } catch {
    // Discovery is best-effort
  }

  // Prompt for missing fields
  if (!oauthMeta.authorization_url || !oauthMeta.token_url || !oauthMeta.client_id) {
    const rl = readline.createInterface({ input, output });
    try {
      console.log('  OAuth details required:');
      if (!oauthMeta.authorization_url) {
        oauthMeta.authorization_url = (await rl.question('    Authorization URL: ')).trim();
      }
      if (!oauthMeta.token_url) {
        oauthMeta.token_url = (await rl.question('    Token URL: ')).trim();
      }
      if (!oauthMeta.client_id) {
        oauthMeta.client_id = (await rl.question('    Client ID: ')).trim();
      }
      if (!oauthMeta.scopes) {
        const scopesRaw = (await rl.question('    Scopes (comma-separated): ')).trim();
        oauthMeta.scopes = scopesRaw || '';
      }
    } finally {
      rl.close();
    }
  }

  if (!oauthMeta.authorization_url || !oauthMeta.token_url || !oauthMeta.client_id) {
    console.error('  ❌ Authorization URL, Token URL, and Client ID are required for OAuth.');
    return;
  }

  // Run OAuth flow
  try {
    await runOAuthFlow(serverName, oauthMeta);
    console.log('  ✅ OAuth flow completed.');

    // Persist oauth: true in config if not already set
    if (!server.oauth) {
      server.oauth = true;
      await writeConfig(config);
    }
  } catch (err) {
    console.error(`  ❌ OAuth flow failed: ${err.message}`);
  }
}
