import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function configPath() {
  return join(process.env.HOME, '.mcphub.json');
}

const VALID_TYPES = new Set(['stdio', 'sse']);

function validateServer(name, server) {
  if (typeof server !== 'object' || server === null) {
    throw new Error(`Server "${name}" must be an object`);
  }

  if (!VALID_TYPES.has(server.type)) {
    throw new Error(
      `Server "${name}" has invalid type "${server.type}". Must be "stdio" or "sse".`
    );
  }

  if (typeof server.enabled !== 'boolean') {
    throw new Error(`Server "${name}" must have an "enabled" field (boolean)`);
  }

  if (typeof server.description !== 'undefined' && typeof server.description !== 'string') {
    throw new Error(`Server "${name}" description must be a string`);
  }

  if (server.type === 'stdio') {
    if (typeof server.command !== 'string' || server.command.trim() === '') {
      throw new Error(
        `Server "${name}" (type: stdio) must have a non-empty "command" field (string)`
      );
    }

    if (server.args !== undefined && !Array.isArray(server.args)) {
      throw new Error(`Server "${name}" (type: stdio) "args" must be an array of strings`);
    }

    if (server.args !== undefined) {
      for (let i = 0; i < server.args.length; i++) {
        if (typeof server.args[i] !== 'string') {
          throw new Error(
            `Server "${name}" (type: stdio) "args[${i}]" must be a string`
          );
        }
      }
    }

    if (server.env !== undefined && (typeof server.env !== 'object' || server.env === null)) {
      throw new Error(`Server "${name}" (type: stdio) "env" must be an object`);
    }
  }

  if (server.type === 'sse') {
    if (typeof server.url !== 'string' || server.url.trim() === '') {
      throw new Error(
        `Server "${name}" (type: sse) must have a non-empty "url" field (string)`
      );
    }

    if (server.headers !== undefined && (typeof server.headers !== 'object' || server.headers === null)) {
      throw new Error(`Server "${name}" (type: sse) "headers" must be an object`);
    }

    if (server.oauth !== undefined && typeof server.oauth !== 'boolean') {
      throw new Error(`Server "${name}" (type: sse) "oauth" must be a boolean`);
    }

    if (server.insecure !== undefined && typeof server.insecure !== 'boolean') {
      throw new Error(`Server "${name}" (type: sse) "insecure" must be a boolean`);
    }
  }

  if (server.timeout !== undefined && (typeof server.timeout !== 'number' || server.timeout <= 0)) {
    throw new Error(`Server "${name}" "timeout" must be a positive number (milliseconds)`);
  }
}

export async function loadConfig() {
  let raw;
  try {
    raw = await readFile(configPath(), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: 1, servers: {} };
    }
    throw err;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ~/.mcphub.json: ${err.message}`);
  }

  if (typeof config.version !== 'number') {
    throw new Error('Config must have a "version" field (number)');
  }

  if (typeof config.servers !== 'object' || config.servers === null || Array.isArray(config.servers)) {
    throw new Error('Config must have a "servers" field (object)');
  }

  const serverNames = Object.keys(config.servers);

  for (const name of serverNames) {
    validateServer(name, config.servers[name]);
  }

  return config;
}
