// Linux Keychain backend — uses secret-tool from libsecret-tools

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT = 5000;

/**
 * Retrieve an OAuth secret from the GNOME/secret-tool keyring.
 *
 * @param {string} serverName
 * @returns {Promise<object|null>}
 */
export async function get(serverName) {
  try {
    const { stdout } = await execFileAsync(
      'secret-tool',
      ['lookup', 'server', serverName],
      { timeout: TIMEOUT }
    );
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Store an OAuth secret in the GNOME/secret-tool keyring.
 *
 * @param {string} serverName
 * @param {object} secret
 * @returns {Promise<void>}
 */
export async function set(serverName, secret) {
  const json = JSON.stringify(secret);

  await execFileAsync(
    'secret-tool',
    ['store', '--label=gtwmcp', 'server', serverName],
    { timeout: TIMEOUT, input: json }
  );
}

/**
 * Delete an OAuth secret from the GNOME/secret-tool keyring.
 *
 * @param {string} serverName
 * @returns {Promise<void>}
 */
export async function del(serverName) {
  try {
    await execFileAsync(
      'secret-tool',
      ['clear', 'server', serverName],
      { timeout: TIMEOUT }
    );
  } catch {
    // Ignore errors — entry may not exist
  }
}
