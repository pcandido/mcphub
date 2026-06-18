import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function configPath() {
  return join(process.env.HOME, '.mcphub.json');
}

export async function writeConfig(config) {
  const targetPath = configPath();
  const dir = dirname(targetPath);
  const tmpName = `.mcphub.json.${randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  const json = JSON.stringify(config, null, 2) + '\n';

  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, targetPath);
}
