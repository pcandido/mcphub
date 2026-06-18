import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from '../config/loader.js';
import { writeConfig } from '../config/writer.js';
import { get as keychainGet, set as keychainSet, del as keychainDel } from '../keychain/index.js';
import { discoverOAuthMetadata } from '../oauth/discovery.js';
import { runOAuthFlow } from '../oauth/flow.js';

function showUsage() {
  process.stdout.write(
    'Usage: gtwmcp add <name> [--type stdio|sse] [--command <cmd>] [--args <a1,a2>] ' +
    '[--env <K=V,...>] [--url <url>] [--description <desc>] [--oauth] ' +
    '[--oauth-auth-url <url>] [--oauth-token-url <url>] [--oauth-client-id <id>] ' +
    '[--oauth-scopes <s1,s2>]\n'
  );
}

/**
 * Parse command-line flags from an array of string arguments.
 * Returns an object of key -> value. Boolean flags have value true.
 */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const eqIdx = arg.indexOf('=');
    let key, value;
    if (eqIdx !== -1) {
      key = arg.slice(2, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else {
      key = arg.slice(2);
      // Look ahead: if the next arg exists and doesn't start with --, it's the value
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        value = args[i + 1];
        i++; // consume the value
      } else {
        // Boolean flag
        value = true;
      }
    }

    // If the key already exists, collect into an array
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

/**
 * Prompt the user interactively for stdio server details.
 */
async function promptStdio(rl) {
  const command = (await rl.question('  Command: ')).trim();
  if (!command) throw new Error('Command is required for stdio servers');

  const argsRaw = (await rl.question('  Args (comma-separated): ')).trim();
  const args = argsRaw
    ? argsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const envRaw = (await rl.question('  Env (KEY=value, comma-separated): ')).trim();
  const env = {};
  if (envRaw) {
    for (const pair of envRaw.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (k) env[k] = v;
    }
  }

  const description = (await rl.question('  Description: ')).trim();

  return { command, args, env, description };
}

/**
 * Prompt the user interactively for SSE server details.
 */
async function promptSse(rl) {
  const url = (await rl.question('  URL: ')).trim();
  if (!url) throw new Error('URL is required for SSE servers');

  const description = (await rl.question('  Description: ')).trim();

  const oauthRaw = (await rl.question('  OAuth required? [y/N]: ')).trim();
  const oauth = oauthRaw.toLowerCase() === 'y' || oauthRaw.toLowerCase() === 'yes';

  return { url, description, oauth };
}

/**
 * Prompt for OAuth metadata values that haven't been discovered/provided yet.
 */
async function promptOAuthMissing(rl, metadata) {
  const result = { ...metadata };

  if (!result.authorization_url) {
    result.authorization_url = (await rl.question('  Authorization URL: ')).trim();
  }
  if (!result.token_url) {
    result.token_url = (await rl.question('  Token URL: ')).trim();
  }
  if (!result.client_id) {
    result.client_id = (await rl.question('  Client ID: ')).trim();
  }
  if (!result.scopes) {
    const scopesRaw = (await rl.question('  Scopes (comma-separated): ')).trim();
    result.scopes = scopesRaw || '';
  }

  return result;
}

/**
 * Build the server config object and optionally handle OAuth.
 */
async function buildServerConfig(serverName, opts, existingConfig) {
  const config = {};

  if (opts.command !== undefined) {
    // stdio
    config.type = 'stdio';
    config.command = opts.command;
    config.args = opts.args || [];
    if (opts.env && typeof opts.env === 'object' && Object.keys(opts.env).length > 0) {
      config.env = opts.env;
    }
  } else if (opts.url !== undefined) {
    // sse
    config.type = 'sse';
    config.url = opts.url;
    if (opts.description) config.description = opts.description;
    config.enabled = existingConfig?.enabled ?? true;

    if (opts.oauth) {
      config.oauth = true;

      // Gather OAuth metadata: flags > discovery > interactive prompt
      let oauthMeta = {
        authorization_url: opts.oauthAuthUrl || undefined,
        token_url: opts.oauthTokenUrl || undefined,
        client_id: opts.oauthClientId || undefined,
        scopes: opts.oauthScopes || undefined,
      };

      // If auth/token URLs not provided, try discovery
      if (!oauthMeta.authorization_url || !oauthMeta.token_url) {
        process.stderr.write('Discovering OAuth metadata...\n');
        const discovered = await discoverOAuthMetadata(opts.url);
        if (discovered) {
          process.stderr.write('  Found OAuth metadata via .well-known discovery.\n');
          oauthMeta.authorization_url = oauthMeta.authorization_url || discovered.authorization_url;
          oauthMeta.token_url = oauthMeta.token_url || discovered.token_url;
          if (!oauthMeta.scopes && discovered.scopes_supported) {
            process.stderr.write(
              `  Server supports scopes: ${discovered.scopes_supported.join(', ')}\n`
            );
          }
        } else {
          process.stderr.write('  No OAuth metadata discovered.\n');
        }
      }

      // Determine if we need to prompt
      const isNonInteractive = opts.type !== undefined; // has --type means non-interactive
      if (!oauthMeta.authorization_url || !oauthMeta.token_url || !oauthMeta.client_id) {
        // Need prompts even in non-interactive for missing OAuth bits
        const rl = readline.createInterface({ input, output });
        try {
          process.stdout.write('OAuth details required:\n');
          oauthMeta = await promptOAuthMissing(rl, oauthMeta);
        } finally {
          rl.close();
        }
      }

      if (!oauthMeta.authorization_url || !oauthMeta.token_url || !oauthMeta.client_id) {
        throw new Error('Authorization URL, Token URL, and Client ID are required for OAuth');
      }

      // Check if we should re-auth
      let doAuth = true;
      if (existingConfig?.oauth === true) {
        // Server already had OAuth — check keychain
        const existingKeychain = await keychainGet(serverName);
        if (existingKeychain) {
          const rl = readline.createInterface({ input, output });
          try {
            const reAuth = (await rl.question(
              'Server already has OAuth credentials. Re-authenticate? [y/N]: '
            )).trim().toLowerCase();
            doAuth = reAuth === 'y' || reAuth === 'yes';
          } finally {
            rl.close();
          }
        }
      }

      if (doAuth) {
        process.stderr.write('Starting OAuth flow...\n');
        await runOAuthFlow(serverName, {
          authorization_url: oauthMeta.authorization_url,
          token_url: oauthMeta.token_url,
          client_id: oauthMeta.client_id,
          scopes: oauthMeta.scopes,
        });
        process.stderr.write('OAuth flow completed.\n');
      }
    }

    return config;
  }

  if (opts.description) config.description = opts.description;
  config.enabled = existingConfig?.enabled ?? true;

  return config;
}

export default async function addServer(args) {
  const serverName = args[0];

  if (!serverName) {
    showUsage();
    process.exit(1);
  }

  // Load existing config
  const config = await loadConfig();
  const existingServer = config.servers[serverName] || null;

  // Determine mode: interactive if no --type flag; non-interactive otherwise
  const flags = parseFlags(args.slice(1));

  const isInteractive = flags.type === undefined;

  if (isInteractive) {
    // --- Interactive mode ---
    const rl = readline.createInterface({ input, output });

    try {
      process.stdout.write(`Adding MCP server: ${serverName}\n`);

      let serverType;
      while (true) {
        serverType = (await rl.question('Server type? [stdio/sse]: ')).trim().toLowerCase();
        if (serverType === 'stdio' || serverType === 'sse') break;
        process.stderr.write('  Please enter "stdio" or "sse".\n');
      }

      let opts;

      if (serverType === 'stdio') {
        const stdioOpts = await promptStdio(rl);
        opts = {
          type: 'stdio',
          command: stdioOpts.command,
          args: stdioOpts.args,
          env: stdioOpts.env,
          description: stdioOpts.description,
        };
      } else {
        const sseOpts = await promptSse(rl);
        opts = {
          type: 'sse',
          url: sseOpts.url,
          description: sseOpts.description,
          oauth: sseOpts.oauth,
        };
      }

      const newServer = await buildServerConfig(serverName, opts, existingServer);
      newServer.type = serverType;
      if (opts.description !== undefined) newServer.description = opts.description;

      config.servers[serverName] = newServer;
    } finally {
      rl.close();
    }
  } else {
    // --- Non-interactive mode ---
    const type = flags.type;

    if (type !== 'stdio' && type !== 'sse') {
      process.stderr.write(`Error: --type must be "stdio" or "sse", got "${type}"\n`);
      process.exit(1);
    }

    let opts = { type };

    if (type === 'stdio') {
      if (!flags.command) {
        process.stderr.write('Error: --command is required for --type stdio\n');
        process.exit(1);
      }
      opts.command = flags.command;

      if (flags.args) {
        const argsRaw = typeof flags.args === 'string' ? flags.args : '';
        opts.args = argsRaw ? argsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      }

      if (flags.env) {
        const envRaw = typeof flags.env === 'string' ? flags.env : '';
        const env = {};
        if (envRaw) {
          for (const pair of envRaw.split(',')) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) continue;
            const k = pair.slice(0, eqIdx).trim();
            const v = pair.slice(eqIdx + 1).trim();
            if (k) env[k] = v;
          }
        }
        if (Object.keys(env).length > 0) {
          opts.env = env;
        }
      }

      if (flags.description) {
        opts.description = typeof flags.description === 'string' ? flags.description : '';
      }
    } else {
      // sse
      if (!flags.url) {
        process.stderr.write('Error: --url is required for --type sse\n');
        process.exit(1);
      }
      opts.url = typeof flags.url === 'string' ? flags.url : '';

      if (flags.description) {
        opts.description = typeof flags.description === 'string' ? flags.description : '';
      }

      if (flags.oauth) {
        opts.oauth = true;

        if (flags['oauth-auth-url']) {
          opts.oauthAuthUrl = typeof flags['oauth-auth-url'] === 'string' ? flags['oauth-auth-url'] : '';
        }
        if (flags['oauth-token-url']) {
          opts.oauthTokenUrl = typeof flags['oauth-token-url'] === 'string' ? flags['oauth-token-url'] : '';
        }
        if (flags['oauth-client-id']) {
          opts.oauthClientId = typeof flags['oauth-client-id'] === 'string' ? flags['oauth-client-id'] : '';
        }
        if (flags['oauth-scopes']) {
          opts.oauthScopes = typeof flags['oauth-scopes'] === 'string' ? flags['oauth-scopes'] : '';
        }
      }
    }

    if (existingServer) {
      process.stderr.write(
        `Server "${serverName}" already exists — updating configuration.\n`
      );
    }

    const newServer = await buildServerConfig(serverName, opts, existingServer);

    // Merge with existing if there are fields we didn't touch
    if (existingServer) {
      const merged = { ...existingServer };
      for (const key of Object.keys(newServer)) {
        if (newServer[key] !== undefined) {
          merged[key] = newServer[key];
        }
      }
      config.servers[serverName] = merged;
    } else {
      config.servers[serverName] = newServer;
    }
  }

  // Write config
  await writeConfig(config);

  process.stdout.write(`Server "${serverName}" added successfully.\n`);
}
