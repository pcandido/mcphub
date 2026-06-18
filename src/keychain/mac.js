// macOS Keychain backend — uses /usr/bin/security CLI

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ACCOUNT = 'gtwmcp';
const TIMEOUT = 5000;

/**
 * Retrieve an OAuth secret from the macOS keychain.
 *
 * @param {string} serverName
 * @returns {Promise<object|null>}
 */
export async function get(serverName) {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-a', ACCOUNT, '-s', serverName, '-w'],
      { timeout: TIMEOUT }
    );
    return JSON.parse(stdout.trim());
  } catch (err) {
    if (err.code !== 0) {
      return null;
    }
    throw err;
  }
}

/**
 * Store an OAuth secret in the macOS keychain.
 *
 * @param {string} serverName
 * @param {object} secret
 * @returns {Promise<void>}
 */
export async function set(serverName, secret) {
  const json = JSON.stringify(secret);

  // Remove any existing entry (ignore errors)
  try {
    await execFileAsync(
      '/usr/bin/security',
      ['delete-generic-password', '-a', ACCOUNT, '-s', serverName],
      { timeout: TIMEOUT }
    );
  } catch {
    // Entry might not exist — that's fine
  }

  // Add the new entry
  await execFileAsync(
    '/usr/bin/security',
    ['add-generic-password', '-a', ACCOUNT, '-s', serverName, '-w', json, '-U'],
    { timeout: TIMEOUT }
  );
}

/**
 * Delete an OAuth secret from the macOS keychain.
 *
 * @param {string} serverName
 * @returns {Promise<void>}
 */
export async function del(serverName) {
  try {
    await execFileAsync(
      '/usr/bin/security',
      ['delete-generic-password', '-a', ACCOUNT, '-s', serverName],
      { timeout: TIMEOUT }
    );
  } catch {
    // Ignore errors — entry may not exist
  }
}
