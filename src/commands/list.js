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
      } else {
        const now = Date.now();
        const expiresAt = secret.expires_at ? new Date(secret.expires_at).getTime() : null;
        if (expiresAt && now >= expiresAt) {
          // Token expired — refresh might still work, but mark as expired
          if (secret.refresh_token) {
            status = '⚠️  auth expired';
          } else {
            status = '🔐 needs auth';
          }
        } else {
          const remaining = expiresAt ? Math.round((expiresAt - now) / 60000) : null;
          status = remaining != null
            ? `✅ authenticated (${remaining}m)`
            : '✅ authenticated';
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
