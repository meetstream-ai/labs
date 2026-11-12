import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  get(kind, id) {
    const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return r ? JSON.parse(r.data) : null;
  }
  all(kind) {
    return this.db
      .prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid')
      .all(kind)
      .map((r) => JSON.parse(r.data));
  }
  put(kind, id, data) {
    this.db
      .prepare(
        'INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, id, JSON.stringify(data));
    return data;
  }
  close() {
    this.db.close();
  }
}

// ponytail: SQLite's OS lock provides crash-safe single ownership without PID files or stale-lock races.
export function acquireOwner(path) {
  const owner = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    owner.exec('BEGIN EXCLUSIVE');
    return owner;
  } catch {
    owner.close();
    throw new Error('Another bridge owns this state directory');
  }
}
