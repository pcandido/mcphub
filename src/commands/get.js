import { loadConfig } from '../config/loader.js';
import { StdioClient } from '../mcp/stdio-client.js';
import { SseClient } from '../mcp/sse-client.js';
import { get as keychainGet } from '../keychain/index.js';
import { refreshTokenIfNeeded } from '../oauth/refresh.js';

export default async function getServer(args) {
  const serverName = args[0];

  if (!serverName) {
    console.error('Usage: mcphub get <name>');
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

  console.log(`${serverName} (${server.type}) — ${typeLabel}`);

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
    console.log('Listing tools...\n');
    const tools = await client.listTools();
    printTools(tools);
  } finally {
    client.stop();
  }
}

async function handleSse(serverName, server) {
  let token = null;

  if (server.oauth) {
    const secret = await keychainGet(serverName);
    if (!secret) {
      console.error('Not authenticated. Run: mcphub auth ' + serverName);
      process.exit(1);
    }

    token = await refreshTokenIfNeeded(serverName);
    if (!token) {
      console.error('Token expired and refresh failed. Run: mcphub auth ' + serverName);
      process.exit(1);
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
    console.log('Listing tools...\n');
    const tools = await client.listTools();
    printTools(tools);
  } catch (err) {
    if (err.message === 'OAuth token expired' || (err.statusCode && err.statusCode === 401)) {
      console.error('Token expired during request. Run: mcphub auth ' + serverName);
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
    console.log('0 tools available.');
    return;
  }

  tools.forEach((tool, i) => {
    const desc = tool.description || '';
    console.log(`${i + 1}. ${tool.name}: ${desc}`);
  });

  console.log(`\n${tools.length} tools available.`);
}
