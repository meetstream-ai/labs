// Where each user's Zoom refresh token lives.
//
// This template writes a JSON file under DATA_DIR (./data by default, which is
// gitignored) so it runs with zero infrastructure. That is fine on a laptop and
// wrong in production: refresh tokens are long-lived credentials for your
// users' Zoom accounts. In production, keep them in a real secret store or an
// encrypted database column (KMS, Vault, Secrets Manager, pgcrypto, ...), and
// keep the same three operations: get, save, delete.
//
// Refresh tokens stay on your side. MeetStream never receives them: the bot
// only ever sees the short-lived ZAK or OBF token your mint endpoint returns.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createTokenStore(dataDir) {
  const file = path.resolve(dataDir, 'zoom-tokens.json');
  let cache = null;
  // Serialize writes so two concurrent refreshes cannot interleave a
  // read-modify-write and drop one user's rotated refresh token.
  let writeChain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not read ${file}: ${error.message}`);
      }
      cache = {};
    }
    return cache;
  }

  async function persist() {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    // Owner read/write only, then an atomic rename so a crash mid-write never
    // leaves a truncated file behind.
    await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  function queue(task) {
    const next = writeChain.then(task, task);
    writeChain = next.catch(() => {});
    return next;
  }

  return {
    file,

    /** @returns {Promise<{refresh_token: string, scope?: string, connected_at?: string, updated_at?: string} | null>} */
    async get(userId) {
      const all = await load();
      return all[userId] || null;
    },

    save(userId, record) {
      return queue(async () => {
        const all = await load();
        all[userId] = { ...all[userId], ...record, updated_at: new Date().toISOString() };
        await persist();
      });
    },

    delete(userId) {
      return queue(async () => {
        const all = await load();
        delete all[userId];
        await persist();
      });
    }
  };
}
