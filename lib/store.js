import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const fields = ['sortOrder', 'systemName', 'url', 'commonAccount', 'ip', 'servicePort', 'sshPort', 'serverAccount', 'externalAccess', 'notes'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateSite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '입력 내용을 확인해 주세요.');
  const site = {};
  if (typeof input.sortOrder !== 'number' || !Number.isSafeInteger(input.sortOrder) || input.sortOrder < 1 || input.sortOrder > 999999) {
    throw new HttpError(400, '순서는 1~999999 사이의 정수로 입력해 주세요.');
  }
  site.sortOrder = input.sortOrder;
  for (const field of fields.slice(1)) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new HttpError(400, '문자 입력값을 확인해 주세요.');
    site[field] = (input[field] ?? (field === 'externalAccess' ? 'unknown' : '')).trim();
    const max = field === 'systemName' ? 100 : field === 'notes' ? 4000 : 2000;
    if (site[field].length > max) throw new HttpError(400, '입력 내용이 너무 깁니다.');
  }
  if (!site.systemName) throw new HttpError(400, '시스템명을 입력해 주세요.');
  if (site.url) {
    try {
      const url = new URL(site.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw new HttpError(400, 'URL은 http:// 또는 https://로 시작하는 주소를 입력해 주세요.'); }
  }
  if (site.ip && !isIP(site.ip)) throw new HttpError(400, 'IP 주소 형식을 확인해 주세요.');
  for (const key of ['servicePort', 'sshPort']) {
    if (site[key] && !site[key].split(',').every(port => /^\d{1,5}$/.test(port.trim()) && Number(port) >= 1 && Number(port) <= 65535)) {
      throw new HttpError(400, '포트는 1~65535 사이 숫자로 입력해 주세요. 여러 개는 쉼표로 구분합니다.');
    }
    site[key] = site[key].split(',').map(port => port.trim()).join(', ');
  }
  if (!['yes', 'no', 'unknown'].includes(site.externalAccess)) throw new HttpError(400, '외부접근 여부를 확인해 주세요.');
  return site;
}

export function createStore({ dataDir, backupDir, seed = [] }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, 'sites.sqlite');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
      action TEXT NOT NULL, actor_id INTEGER REFERENCES users(id), actor_name TEXT NOT NULL,
      changed_at TEXT NOT NULL, before_data TEXT, after_data TEXT NOT NULL, backup_file TEXT
    );
    CREATE INDEX IF NOT EXISTS history_site ON history(site_id, id DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  transaction(() => {
    if (!userColumns.includes('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE');
    if (!userColumns.includes('job_title')) db.exec("ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)');
  });
  function recordHistory(id, action, actor, before, after, backupFile, now) {
    db.prepare('INSERT INTO history (site_id, action, actor_id, actor_name, changed_at, before_data, after_data, backup_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, action, actor.id, actor.name, now, before ? JSON.stringify(before) : null, JSON.stringify(after), backupFile);
  }
  if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'initialized'").get()) {
    const localSeed = join(dataDir, 'initial-sites.json');
    const initial = existsSync(localSeed) ? JSON.parse(readFileSync(localSeed, 'utf8')) : seed;
    transaction(() => {
      const now = new Date().toISOString();
      for (const input of initial) {
        const item = validateSite(input);
        const { lastInsertRowid } = db.prepare('INSERT INTO sites (data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(JSON.stringify(item), now, now, '초기 등록');
        recordHistory(Number(lastInsertRowid), 'create', { id: null, name: '초기 등록' }, null, { ...item, deleted: false }, null, now);
      }
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('initialized', now);
    });
  }
  const rowToSite = row => row ? ({ id: row.id, ...JSON.parse(row.data), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by, deletedAt: row.deleted_at }) : null;
  const find = id => rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
  let queue = Promise.resolve();
  function serialize(fn) {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  }
  async function snapshot(action) {
    const filename = `${new Date().toISOString().replaceAll(':', '-')}_${action}_${randomUUID()}.sqlite`;
    const target = resolve(backupDir, filename);
    try {
      await backup(db, `${target}.tmp`);
      chmodSync(`${target}.tmp`, 0o600);
      await rename(`${target}.tmp`, target);
      return filename;
    } catch {
      await unlink(`${target}.tmp`).catch(() => {});
      throw new HttpError(503, '변경 전 백업에 실패하여 저장하지 않았습니다. 서버의 백업 폴더와 여유 공간을 확인해 주세요.');
    }
  }
  return {
    db,
    list: () => db.prepare('SELECT * FROM sites').all().map(rowToSite).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    find,
    history(id) {
      if (!find(id)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
      return db.prepare('SELECT * FROM history WHERE site_id = ? ORDER BY id DESC').all(id).map(row => ({
        id: row.id, action: row.action, actor: row.actor_name, changedAt: row.changed_at,
        before: row.before_data ? JSON.parse(row.before_data) : null, after: JSON.parse(row.after_data), backupFile: row.backup_file,
      }));
    },
    createUser({ username, name, jobTitle }, passwordHash) {
      return serialize(async () => {
        if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
        if (db.prepare('SELECT id FROM users WHERE name = ?').get(name)) throw new HttpError(409, '이미 사용 중인 이름입니다. 동명이인은 구분할 수 있는 이름을 사용해 주세요.');
        await snapshot('signup');
        const result = transaction(() => db.prepare('INSERT INTO users (username, name, job_title, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(username, name, jobTitle, passwordHash, new Date().toISOString()));
        return { id: Number(result.lastInsertRowid), username, name, jobTitle };
      });
    },
    mutate(action, id, input, actor) {
      return serialize(async () => {
        const old = id ? find(id) : null;
        if (action !== 'create' && (!old || old.deletedAt)) throw new HttpError(404, '이미 삭제되었거나 존재하지 않는 항목입니다.');
        if (old && input.version !== old.version) throw new HttpError(409, '다른 사람이 먼저 변경했습니다. 입력 내용을 보관한 뒤 목록을 새로고침하고 다시 수정해 주세요.');
        const next = action === 'delete' ? Object.fromEntries(fields.map(field => [field, old[field]])) : validateSite(input);
        if (action === 'update' && fields.every(field => next[field] === old[field])) return { site: old, changed: false };
        const backupFile = await snapshot(action);
        return transaction(() => {
          const now = new Date().toISOString();
          if (action === 'create') {
            id = Number(db.prepare('INSERT INTO sites (data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(JSON.stringify(next), now, now, actor.name).lastInsertRowid);
          } else {
            db.prepare('UPDATE sites SET data = ?, version = version + 1, updated_at = ?, updated_by = ?, deleted_at = ? WHERE id = ?')
              .run(JSON.stringify(next), now, actor.name, action === 'delete' ? now : null, id);
          }
          const before = old ? { ...Object.fromEntries(fields.map(field => [field, old[field]])), deleted: false } : null;
          recordHistory(id, action, actor, before, { ...next, deleted: action === 'delete' }, backupFile, now);
          return { site: find(id), changed: true };
        });
      });
    },
    permanentlyDelete(id, input) {
      return serialize(async () => {
        const old = find(id);
        if (!old) throw new HttpError(404, '이미 완전 삭제되었거나 존재하지 않는 항목입니다.');
        if (!old.deletedAt) throw new HttpError(409, '삭제된 목록의 항목만 완전 삭제할 수 있습니다.');
        if (input.version !== old.version) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.');
        await snapshot('permanent-delete');
        return transaction(() => {
          db.prepare('DELETE FROM history WHERE site_id = ?').run(id);
          db.prepare('DELETE FROM sites WHERE id = ?').run(id);
          return { changed: true };
        });
      });
    },
    async close() { await queue; db.close(); },
  };
}
