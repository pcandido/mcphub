import { loadConfig } from '../config/loader.js';
import { get as keychainGet } from '../keychain/index.js';

export default async function list() {
  const config = await loadConfig();

  const servers = Object.entries(config.servers);
  if (servers.length === 0) {
    process.stdout.write('No servers configured.\n');
    return;
  }

  const rows = {};
  for (const [name, server] of servers) {
    let status;
    if (!server.enabled) {
      status = '❌ disabled';
    } else if (server.oauth) {
      const secret = await keychainGet(name);
      if (!secret || !secret.access_token) {
        status = '🔐 needs auth';
      } else if (!secret.refresh_token) {
        status = '🔐 needs auth';
      } else {
        const now = Date.now();
        const refreshExpiresAt = secret.refresh_expires_at
          ? new Date(secret.refresh_expires_at).getTime()
          : null;
        if (refreshExpiresAt && now >= refreshExpiresAt) {
          status = '🔐 needs auth';
        } else {
          status = '✅ authenticated';
        }
      }
    } else {
      status = '✅ enabled';
    }

    rows[name] = {
      type: server.type,
      status,
      description: server.description || '-',
    };
  }

  console.table(rows, ['type', 'status', 'description']);
}
