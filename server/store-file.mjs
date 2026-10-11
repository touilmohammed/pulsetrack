// Stockage local de développement : un fichier JSON (server/data/db.json, ignoré par Git).
// Même interface que le stockage Netlify Blobs de la production.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createFileStore(path) {
  let data = {};
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });

  // Écritures sérialisées, et atomiques (fichier temporaire puis renommage).
  let queue = Promise.resolve();
  const persist = () => {
    queue = queue.then(async () => {
      await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2));
      await rename(`${path}.tmp`, path);
    });
    return queue;
  };
  const copy = (value) => (value === undefined ? null : structuredClone(value));

  return {
    async get(key) {
      return copy(data[key]);
    },
    async set(key, value) {
      data[key] = structuredClone(value);
      await persist();
    },
    async delete(key) {
      delete data[key];
      await persist();
    },
    async list(prefix) {
      return Object.keys(data).filter((key) => key.startsWith(prefix)).map((key) => copy(data[key]));
    },
  };
}
