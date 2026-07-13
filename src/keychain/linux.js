// Linux Keychain backend — uses secret-tool from libsecret-tools

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT = 5000;

const SECRET_TOOL_HELP = `
  secret-tool (from libsecret-tools) is not available or the keyring service is unreachable.

  To fix this:

  1. Install the required packages:
     sudo apt install libsecret-tools gnome-keyring

  2. If you're on a headless server (no desktop), start the keyring daemon:
     dbus-run-session -- gnome-keyring-daemon --unlock

  3. If you're on KDE, install the KDE wallet integration instead:
     sudo apt install libsecret-tools kwalletmanager

  4. Verify it works:
     echo "test" | secret-tool store --label="test" app test
     secret-tool lookup app test
     secret-tool clear app test
`.trim();

/**
 * Check whether secret-tool and the secret service are available.
 *
 * Runs secret-tool lookup on a non-existent key — if it exits cleanly the
 * tool is installed and the D-Bus secret service is reachable.
 *
 * @returns {Promise<{ok: boolean, advice: string}>}
 */
export async function checkAvailability() {
  try {
    await execFileAsync(
      'secret-tool',
      ['lookup', 'app', '__mcphub_check__'],
      { timeout: TIMEOUT }
    );
    return { ok: true, advice: '' };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const message = (err.message || '').toString();

    // secret-tool binary not found
    if (message.includes('ENOENT') || message.includes('not found')) {
      return {
        ok: false,
        advice: 'secret-tool is not installed. Run: sudo apt install libsecret-tools gnome-keyring',
      };
    }

    // Binary exists but can't reach the secret service (no keyring daemon)
    if (
      stderr.includes('Cannot create an item in a locked collection') ||
      stderr.includes('No such secret collection') ||
      stderr.includes('The name org.freedesktop.secrets was not provided') ||
      stderr.includes('org.freedesktop.DBus.Error.ServiceUnknown') ||
      stderr.includes('cannot create an item') ||
      stderr.toLowerCase().includes('secret service') ||
      message.includes('secret-tool') // generic secret-tool failure
    ) {
      return {
        ok: false,
        advice: SECRET_TOOL_HELP,
      };
    }

    return { ok: false, advice: `secret-tool check failed: ${stderr || message}` };
  }
}

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

  try {
    await execFileAsync(
      'secret-tool',
      ['store', '--label=mcphub', 'server', serverName],
      { timeout: TIMEOUT, input: json }
    );
  } catch (err) {
    // Diagnose the failure and give actionable advice
    const { ok, advice } = await checkAvailability();

    let message;
    if (!ok) {
      message = `Cannot store secret: ${advice}`;
    } else {
      // secret-tool is available but the store still failed — likely stderr has details
      const stderr = (err.stderr || '').toString().trim();
      message = stderr
        ? `Cannot store secret: ${stderr}`
        : `Cannot store secret: secret-tool exited with code ${err.code || 'unknown'}`;
    }

    const error = new Error(message);
    error.code = 'KEYCHAIN_STORE_FAILED';
    throw error;
  }
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
