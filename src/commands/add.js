import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from '../config/loader.js';
import { writeConfig } from '../config/writer.js';

function showUsage() {
  process.stdout.write(
    'Usage: gtwmcp add <name> [--type stdio|sse] [--command <cmd>] [--args <a1,a2>] ' +
    '[--env <K,V,...>] [--url <url>] [--description <desc>] [--oauth]\n'
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
      // --oauth just marks the server; actual auth flow is done by 'gtwmcp auth'
      config.oauth = true;
    } else {
      config.oauth = false;
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
