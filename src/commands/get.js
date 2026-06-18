import { loadConfig } from '../config/loader.js';
import { get as keychainGet } from '../keychain/index.js';

export default async function get(args) {
  const [serverName] = args;

  const config = await loadConfig();

  const server = config.servers[serverName];
  if (!server) {
    process.stderr.write(`Server '${serverName}' not found.\n`);
    process.exit(1);
  }

  // Build a safe copy without any secret fields
  const safe = { name: serverName, ...server };
  if (safe.oauth && safe.secret) {
    delete safe.secret;
  }

  process.stdout.write(JSON.stringify(safe, null, 2) + '\n');

  // If OAuth is enabled, check token status from keychain
  if (server.oauth === true) {
    let secret;
    try {
      secret = await keychainGet(serverName);
    } catch {
      secret = null;
    }

    if (!secret) {
      process.stdout.write('(OAuth: not authenticated)\n');
    } else if (secret.expires_at) {
      const now = Date.now();
      const expiresAt = new Date(secret.expires_at).getTime();

      if (now >= expiresAt) {
        process.stdout.write('(OAuth: token expired, re-authenticate with gtwmcp add)\n');
      } else {
        const d = new Date(expiresAt);
        process.stdout.write(`(OAuth: authenticated, expires ${d.toLocaleString()})\n`);
      }
    } else {
      process.stdout.write('(OAuth: authenticated, no expiration)\n');
    }
  }
}
