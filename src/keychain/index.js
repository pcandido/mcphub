// OS Keychain abstraction — detect platform and export the right backend

const platform = process.platform;

/** @type {{ get: (serverName: string) => Promise<object|null>, set: (serverName: string, secret: object) => Promise<void>, del: (serverName: string) => Promise<void> }} */
let backend;

if (platform === 'darwin') {
  backend = await import('./mac.js');
} else if (platform === 'linux') {
  backend = await import('./linux.js');
} else {
  throw new Error(`Unsupported platform: ${platform}`);
}

export const { get, set, del, checkAvailability } = backend;
