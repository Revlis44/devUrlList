import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const connectionFields = ['url', 'commonAccount', 'ip', 'servicePort', 'sshPort', 'serverAccount', 'externalAccess', 'notes'];
export const fields = ['systemName', ...connectionFields, 'groupId', 'components'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validateDetails(input, nameField) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '입력 내용을 확인해 주세요.');
  const site = {};
  for (const field of [nameField, ...connectionFields]) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new HttpError(400, '문자 입력값을 확인해 주세요.');
    site[field] = (input[field] ?? (field === 'externalAccess' ? 'unknown' : '')).trim();
    const max = field === nameField ? 100 : field === 'notes' ? 4000 : 2000;
    if (site[field].length > max) throw new HttpError(400, '입력 내용이 너무 깁니다.');
  }
  if (!site[nameField]) throw new HttpError(400, nameField === 'systemName' ? '시스템명을 입력해 주세요.' : '하위 항목명을 입력해 주세요.');
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

export function validateSite(input) {
  const site = validateDetails(input, 'systemName');
  site.groupId = validateGroupId(input.groupId);
  const components = input.components === undefined ? [] : input.components;
  if (!Array.isArray(components)) throw new HttpError(400, '하위 정보를 확인해 주세요.');
  site.components = components.map(component => {
    if (!component || typeof component !== 'object' || Array.isArray(component) || !['WAS', 'WEB', 'DB', 'PROXY', 'OTHER'].includes(component.type)) throw new HttpError(400, '하위 항목의 구분을 확인해 주세요.');
    for (const field of ['useSystemIp', 'useSystemSshPort']) {
      if (component[field] !== undefined && typeof component[field] !== 'boolean') throw new HttpError(400, '시스템과 동일 선택을 확인해 주세요.');
    }
    const useSystemIp = component.useSystemIp ?? false;
    const useSystemSshPort = component.useSystemSshPort ?? false;
    return { type: component.type, ...validateDetails({ ...component, ip: useSystemIp ? '' : component.ip, sshPort: useSystemSshPort ? '' : component.sshPort }, 'name'), useSystemIp, useSystemSshPort };
  });
  return site;
}

export function validateGroupId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '그룹을 확인해 주세요.');
  return value;
}

export function validateProfile(input) {
  const name = typeof input.name === 'string' ? input.name.normalize('NFKC').trim() : '';
  const jobTitle = typeof input.jobTitle === 'string' ? input.jobTitle.normalize('NFKC').trim() : '';
  if (name.length < 2 || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, '이름은 2~40자로 입력해 주세요.');
  if (!jobTitle || jobTitle.length > 40 || /[\p{Cc}\p{Cf}]/u.test(jobTitle)) throw new HttpError(400, '직급은 1~40자로 입력해 주세요.');
  return { name, jobTitle };
}

export function compareSiteOrder(a, b) { return a.treeOrder - b.treeOrder || a.id - b.id; }

export function compareGroupOrder(a, b) { return (a.treeOrder ?? Infinity) - (b.treeOrder ?? Infinity) || a.name.localeCompare(b.name, 'ko') || a.id - b.id; }

export function applyGroupOrder(groups, order) { return groups.map(group => ({ ...group, treeOrder: order[group.id] ?? null })); }

export function groupOrderMap(groups) {
  const order = {};
  for (const parentId of new Set(groups.map(group => group.parentId))) {
    groups.filter(group => group.parentId === parentId).sort(compareGroupOrder).forEach((group, index) => { order[group.id] = index + 1; });
  }
  return order;
}

export function planGroupMove(groups, id, input) {
  const old = groups.find(group => group.id === id);
  if (!old) throw new HttpError(404, '그룹을 찾을 수 없습니다.');
  if (old.version !== input.version) throw new HttpError(409, '그룹이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
  if (input.parentId === undefined) throw new HttpError(400, '이동할 상위 그룹을 확인해 주세요.');
  const parentId = validateGroupId(input.parentId);
  const parent = groups.find(group => group.id === parentId);
  if (parentId && !parent) throw new HttpError(400, '상위 그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
  for (let ancestor = parent; ancestor; ancestor = groups.find(group => group.id === ancestor.parentId)) {
    if (ancestor.id === id) throw new HttpError(400, '자기 자신이나 하위 그룹으로 이동할 수 없습니다.');
  }
  if (parent && parent.version !== input.parentVersion) throw new HttpError(409, '상위 그룹이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
  const targetId = validateGroupId(input.targetId);
  const target = groups.find(group => group.id === targetId);
  if (targetId && (!target || target.id === id || target.parentId !== parentId)) throw new HttpError(400, '이동할 위치를 확인해 주세요.');
  if (target && target.version !== input.targetVersion) throw new HttpError(409, '대상 그룹이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
  if (target && !['before', 'after'].includes(input.placement)) throw new HttpError(400, '이동할 위치를 확인해 주세요.');
  const caseName = name => name.replace(/[A-Z]/g, char => char.toLowerCase());
  if (groups.some(group => group.id !== id && group.parentId === parentId && caseName(group.name) === caseName(old.name))) throw new HttpError(409, '같은 위치에 동일한 이름의 그룹이 있습니다.');
  const members = parent => groups.filter(group => group.parentId === parent).sort(compareGroupOrder);
  const destination = members(parentId).filter(group => group.id !== id);
  const index = target ? destination.findIndex(group => group.id === targetId) + (input.placement === 'after' ? 1 : 0) : destination.length;
  destination.splice(index, 0, old);
  if (old.parentId === parentId && members(parentId).every((group, i) => group.id === destination[i].id)) return null;
  const order = groupOrderMap(groups);
  const plans = [{ parentId, members: destination }];
  if (old.parentId !== parentId) plans.push({ parentId: old.parentId, members: members(old.parentId).filter(group => group.id !== id) });
  const updates = [];
  for (const plan of plans) {
    plan.members.forEach((group, i) => {
      if (group.parentId !== plan.parentId || order[group.id] !== i + 1) updates.push({ ...group, parentId: plan.parentId });
    });
  }
  for (const plan of plans) plan.members.forEach((group, i) => { order[group.id] = i + 1; });
  return { order, updates };
}

export function planSiteMove(sites, id, input) {
  const active = sites.filter(site => !site.deletedAt);
  const old = active.find(site => site.id === id);
  if (!old) throw new HttpError(404, '이미 삭제되었거나 존재하지 않는 항목입니다.');
  if (input.version !== old.version) throw new HttpError(409, '시스템이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
  if (input.groupId === undefined) throw new HttpError(400, '이동할 그룹을 확인해 주세요.');
  const groupId = validateGroupId(input.groupId);
  const targetId = validateGroupId(input.targetId);
  const target = targetId ? active.find(site => site.id === targetId) : null;
  if (targetId && (!target || target.id === id || target.groupId !== groupId)) throw new HttpError(400, '이동할 위치를 확인해 주세요.');
  if (target && target.version !== input.targetVersion) throw new HttpError(409, '대상 시스템이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
  if (target && !['before', 'after'].includes(input.placement)) throw new HttpError(400, '이동할 위치를 확인해 주세요.');
  const members = group => active.filter(site => site.groupId === group).sort(compareSiteOrder);
  const destination = members(groupId).filter(site => site.id !== id);
  const index = target ? destination.findIndex(site => site.id === target.id) + (input.placement === 'after' ? 1 : 0) : destination.length;
  destination.splice(index, 0, old);
  if (old.groupId === groupId && members(groupId).every((site, i) => site.id === destination[i].id)) return [];
  const plans = [{ groupId, members: destination }];
  if (old.groupId !== groupId) plans.push({ groupId: old.groupId, members: members(old.groupId).filter(site => site.id !== id) });
  return plans.flatMap(plan => plan.members.map((site, i) => {
    const beforePosition = members(site.groupId).findIndex(item => item.id === site.id) + 1;
    return { old: site, next: { ...Object.fromEntries(fields.map(field => [field, site[field]])), groupId: plan.groupId, treeOrder: i + 1 }, beforePosition, afterPosition: i + 1,
      changed: site.groupId !== plan.groupId || beforePosition !== i + 1 };
  }));
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
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      parent_id INTEGER REFERENCES groups(id), version INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS groups_sibling_name ON groups(COALESCE(parent_id, 0), name COLLATE NOCASE);
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
  const findGroup = id => db.prepare('SELECT id, name, parent_id AS parentId, version FROM groups WHERE id = ?').get(id) ?? null;
  const readGroupOrder = () => JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'group-order'").get()?.value ?? '{}');
  const listGroups = () => applyGroupOrder(db.prepare('SELECT id, name, parent_id AS parentId, version FROM groups ORDER BY name COLLATE NOCASE, id').all(), readGroupOrder());
  const saveGroupOrder = order => db.prepare("INSERT INTO metadata (key, value) VALUES ('group-order', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(order));
  function groupName(id) {
    const names = [];
    for (let group = id ? findGroup(id) : null; group; group = group.parentId ? findGroup(group.parentId) : null) names.unshift(group.name);
    return names.join(' / ') || '미분류';
  }
  function recordHistory(id, action, actor, before, after, backupFile, now) {
    if (before) before = { ...before, groupName: groupName(before.groupId) };
    after = { ...after, groupName: groupName(after.groupId) };
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
  const siteQuery = `SELECT sites.*, COALESCE((
    SELECT users.job_title FROM history LEFT JOIN users ON users.id = history.actor_id
    WHERE history.site_id = sites.id ORDER BY history.id DESC LIMIT 1
  ), '') AS updated_by_job_title FROM sites`;
  const rowToSite = row => {
    if (!row) return null;
    const data = JSON.parse(row.data);
    delete data.sortOrder;
    return { id: row.id, groupId: null, components: [], treeOrder: row.id, ...data, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by, updatedByJobTitle: row.updated_by_job_title, deletedAt: row.deleted_at };
  };
  const find = id => rowToSite(db.prepare(`${siteQuery} WHERE sites.id = ?`).get(id));
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
    checkReady: () => db.prepare('SELECT 1').get(),
    userByUsername: username => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    userForSession: (token, now) => db.prepare('SELECT users.id, users.username, users.name, users.job_title AS jobTitle FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(token, now) ?? null,
    createSession(token, userId, expiresAt, oldToken, now) {
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').run(now, oldToken);
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, userId, expiresAt);
      });
    },
    deleteSession: token => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(token),
    list: () => db.prepare(`${siteQuery} ORDER BY sites.id`).all().map(rowToSite),
    find,
    listGroups,
    moveGroup(id, input) {
      return serialize(async () => {
        const plan = planGroupMove(listGroups(), id, input);
        if (!plan) return { group: listGroups().find(group => group.id === id), changed: false };
        await snapshot('group-move');
        return transaction(() => {
          for (const group of plan.updates) db.prepare('UPDATE groups SET parent_id = ?, version = version + 1 WHERE id = ?').run(group.parentId, group.id);
          saveGroupOrder(plan.order);
          return { group: listGroups().find(group => group.id === id), changed: true };
        });
      });
    },
    mutateGroup(action, id, input) {
      return serialize(async () => {
        const old = id ? findGroup(id) : null;
        if (action !== 'create' && !old) throw new HttpError(404, '그룹을 찾을 수 없습니다.');
        if (old && input.version !== old.version) throw new HttpError(409, '다른 사람이 그룹을 변경했습니다. 목록을 새로고침한 뒤 다시 수정해 주세요.');
        let name, parentId;
        if (action === 'delete') {
          if (db.prepare('SELECT 1 FROM groups WHERE parent_id = ?').get(id) || db.prepare("SELECT 1 FROM sites WHERE json_extract(data, '$.groupId') = ?").get(id)) {
            throw new HttpError(409, '서버(삭제된 목록 포함) 또는 하위 그룹이 있는 그룹은 삭제할 수 없습니다. 먼저 소속 항목을 정리해 주세요.');
          }
        } else {
          name = typeof input.name === 'string' ? input.name.normalize('NFKC').trim() : '';
          if (!name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, '그룹명은 1~100자로 입력해 주세요.');
          parentId = validateGroupId(input.parentId);
          if (parentId && !findGroup(parentId)) throw new HttpError(400, '상위 그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
          for (let parent = parentId ? findGroup(parentId) : null; parent; parent = parent.parentId ? findGroup(parent.parentId) : null) {
            if (parent.id === id) throw new HttpError(400, '자기 자신이나 하위 그룹을 상위 그룹으로 지정할 수 없습니다.');
          }
          const duplicate = db.prepare('SELECT id FROM groups WHERE parent_id IS ? AND name = ? COLLATE NOCASE').get(parentId, name);
          if (duplicate && duplicate.id !== id) throw new HttpError(409, '같은 위치에 동일한 이름의 그룹이 있습니다.');
          if (old && old.name === name && old.parentId === parentId) return { group: listGroups().find(group => group.id === id), changed: false };
        }
        const currentGroups = listGroups();
        await snapshot(`group-${action}`);
        return transaction(() => {
          if (action === 'delete') {
            db.prepare('DELETE FROM groups WHERE id = ?').run(id);
            const order = readGroupOrder();
            if (Object.hasOwn(order, id)) { delete order[id]; saveGroupOrder(order); }
            return { changed: true };
          }
          if (action === 'create') id = Number(db.prepare('INSERT INTO groups (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid);
          else db.prepare('UPDATE groups SET name = ?, parent_id = ?, version = version + 1 WHERE id = ?').run(name, parentId, id);
          if (old && old.parentId !== parentId || action === 'create' && Object.keys(readGroupOrder()).length) {
            const order = groupOrderMap(currentGroups);
            order[id] = currentGroups.filter(group => group.parentId === parentId && group.id !== id).length + 1;
            saveGroupOrder(order);
          }
          return { group: listGroups().find(group => group.id === id), changed: true };
        });
      });
    },
    history(id) {
      if (!find(id)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
      return db.prepare(`SELECT history.*, COALESCE(users.job_title, '') AS actor_job_title
        FROM history LEFT JOIN users ON users.id = history.actor_id
        WHERE history.site_id = ? ORDER BY history.id DESC`).all(id).map(row => ({
        id: row.id, action: row.action, actor: row.actor_name, actorJobTitle: row.actor_job_title, changedAt: row.changed_at,
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
    updateProfile(id, input) {
      return serialize(async () => {
        const profile = validateProfile(input);
        const old = db.prepare('SELECT id, username, name, job_title AS jobTitle FROM users WHERE id = ?').get(id);
        if (!old) throw new HttpError(401, '다시 로그인해 주세요.');
        if (db.prepare('SELECT id FROM users WHERE name = ? AND id <> ?').get(profile.name, id)) throw new HttpError(409, '이미 사용 중인 이름입니다. 동명이인은 구분할 수 있는 이름을 사용해 주세요.');
        if (old.name === profile.name && old.jobTitle === profile.jobTitle) return { user: old, changed: false };
        await snapshot('profile');
        transaction(() => db.prepare('UPDATE users SET name = ?, job_title = ? WHERE id = ?').run(profile.name, profile.jobTitle, id));
        return { user: { ...old, ...profile }, changed: true };
      });
    },
    moveSite(id, input, actor) {
      return serialize(async () => {
        const all = db.prepare(`${siteQuery} ORDER BY sites.id`).all().map(rowToSite);
        const plan = planSiteMove(all, id, input);
        if (input.groupId && !findGroup(input.groupId)) throw new HttpError(400, '그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
        if (!plan.length) return { site: find(id), changed: false };
        const backupFile = await snapshot('move');
        return transaction(() => {
          const now = new Date().toISOString();
          for (const item of plan) {
            if (!item.changed) {
              db.prepare('UPDATE sites SET data = ? WHERE id = ?').run(JSON.stringify(item.next), item.old.id);
              continue;
            }
            db.prepare('UPDATE sites SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(JSON.stringify(item.next), now, actor.name, item.old.id);
            const before = { ...Object.fromEntries(fields.map(field => [field, item.old[field]])), position: item.beforePosition, deleted: false };
            recordHistory(item.old.id, 'move', actor, before, { ...item.next, position: item.afterPosition, deleted: false }, backupFile, now);
          }
          return { site: find(id), changed: true };
        });
      });
    },
    mutate(action, id, input, actor) {
      return serialize(async () => {
        const old = id ? find(id) : null;
        if (action !== 'create' && (!old || old.deletedAt)) throw new HttpError(404, '이미 삭제되었거나 존재하지 않는 항목입니다.');
        if (old && input.version !== old.version) throw new HttpError(409, '다른 사람이 먼저 변경했습니다. 입력 내용을 보관한 뒤 목록을 새로고침하고 다시 수정해 주세요.');
        const next = action === 'delete' ? Object.fromEntries(fields.map(field => [field, old[field]])) : validateSite({ ...input, groupId: input.groupId === undefined ? old?.groupId : input.groupId, components: input.components === undefined ? old?.components : input.components });
        if (next.groupId && !findGroup(next.groupId)) throw new HttpError(400, '그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
        if (action === 'update' && fields.every(field => field === 'components' ? JSON.stringify(next[field]) === JSON.stringify(old[field]) : next[field] === old[field])) return { site: old, changed: false };
        next.treeOrder = old && old.groupId === next.groupId ? old.treeOrder : Math.max(0, ...db.prepare(`${siteQuery} WHERE deleted_at IS NULL`).all().map(rowToSite).filter(site => site.groupId === next.groupId).map(site => site.treeOrder)) + 1;
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
