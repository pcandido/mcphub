import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const CONFIG_PATH = join(process.env.HOME, '.gtwmcp.json');

export async function writeConfig(config) {
  const dir = dirname(CONFIG_PATH);
  const tmpName = `.gtwmcp.json.${randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  const json = JSON.stringify(config, null, 2) + '\n';

  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, CONFIG_PATH);
}
