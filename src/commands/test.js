import { loadConfig } from '../config/loader.js';
import { StdioClient } from '../mcp/stdio-client.js';
import { SseClient } from '../mcp/sse-client.js';
import { get as keychainGet } from '../keychain/index.js';
import { refreshTokenIfNeeded } from '../oauth/refresh.js';

export default async function testServer(args) {
  const serverName = args[0];

  if (!serverName) {
    console.error('Usage: gtwmcp test <name>');
    process.exit(1);
  }

  const config = await loadConfig();
  const server = config.servers[serverName];

  if (!server) {
    console.error(`Server '${serverName}' not found.`);
    process.exit(1);
  }

  const typeLabel = server.type === 'stdio'
    ? `stdio (${server.command} ${(server.args || []).join(' ')})`
    : `sse (${server.url})`;

  console.log(`Connecting to ${serverName} (${server.type}) — ${typeLabel}`);

  if (server.type === 'stdio') {
    await handleStdio(serverName, server);
  } else {
    await handleSse(serverName, server);
  }

  process.exit(0);
}

async function handleStdio(serverName, server) {
  const client = new StdioClient(serverName, {
    command: server.command,
    args: server.args,
    env: server.env,
  });

  try {
    await client.start();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  try {
    console.log('Listing tools...');
    const tools = await client.listTools();
    printTools(tools);
  } finally {
    client.stop();
  }
}

async function handleSse(serverName, server) {
  let token = null;

  if (server.oauth) {
    // Check if we even have a secret stored
    const secret = await keychainGet(serverName);
    if (!secret) {
      console.error("OAuth required but no token found. Run 'gtwmcp add <name>' to authenticate.");
      process.exit(1);
    }

    token = await refreshTokenIfNeeded(serverName);
    if (!token) {
      // Secret existed but refresh failed
      console.error("Authentication failed. Run 'gtwmcp add <name>' to re-authenticate.");
      process.exit(1);
    }

    // Determine remaining validity for the auth status message
    const refreshedSecret = await keychainGet(serverName);
    if (refreshedSecret && refreshedSecret.expires_at) {
      const remainingMs = new Date(refreshedSecret.expires_at).getTime() - Date.now();
      console.log(`Authenticating... OK (token valid, expires in ${Math.round(remainingMs / 60000)}m)`);
    } else {
      console.log('Authenticating... OK');
    }
  }

  const client = new SseClient(serverName, {
    url: server.url,
    headers: server.headers,
    oauth: server.oauth,
  });

  if (token) {
    client.setAccessToken(token);
  }

  try {
    await client.start();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  try {
    console.log('Listing tools...');
    const tools = await client.listTools();
    printTools(tools);
  } catch (err) {
    if (err.message === 'OAuth token expired' || (err.statusCode && err.statusCode === 401)) {
      console.error("Authentication failed. Run 'gtwmcp add <name>' to re-authenticate.");
    } else {
      console.error(err.message);
    }
    process.exit(1);
  } finally {
    client.stop();
  }
}

function printTools(tools) {
  if (!tools || tools.length === 0) {
    console.log('0 tools available - server is healthy.');
    return;
  }

  tools.forEach((tool, i) => {
    const desc = tool.description || '';
    console.log(`${i + 1}. ${tool.name}: ${desc}`);
  });

  console.log(`${tools.length} tools available - server is healthy.`);
}
