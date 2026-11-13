import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fields, validateSite, validateGroupId, validateProfile, planSiteMove, applyGroupOrder, groupOrderMap, planGroupMove, planGroupDelete, planGroupRestore, HttpError } from './store.js';
import { createPool, caseKey, schemaVersion, transaction, withWriteLock, exportRows } from './mariadb.js';

const siteQuery = `SELECT sites.*, COALESCE((
  SELECT users.job_title FROM history LEFT JOIN users ON users.id = history.actor_id
  WHERE history.site_id = sites.id ORDER BY history.id DESC LIMIT 1
), '') AS updated_by_job_title FROM sites`;
const one = async (db, sql, params = []) => (await db.query(sql, params))[0] ?? null;
const rowToSite = row => {
  if (!row) return null;
  const data = JSON.parse(row.data);
  delete data.sortOrder;
  return { id: row.id, groupId: null, components: [], treeOrder: row.id, ...data, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by,
    updatedByJobTitle: row.updated_by_job_title, deletedAt: row.deleted_at };
};
const find = async (db, id) => rowToSite(await one(db, siteQuery + ' WHERE sites.id = ?', [id]));
const findGroup = (db, id) => one(db, 'SELECT id, name, parent_id AS parentId, version FROM `groups` WHERE id = ?', [id]);
const readGroupOrder = async db => JSON.parse((await one(db, "SELECT value FROM metadata WHERE `key` = 'group-order'"))?.value ?? '{}');
const listGroups = async db => applyGroupOrder(await db.query('SELECT id, name, parent_id AS parentId, version FROM `groups` ORDER BY name_key, id'), await readGroupOrder(db));
const saveGroupOrder = (db, order) => db.query("INSERT INTO metadata (`key`, value) VALUES ('group-order', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(order)]);
const readArchivedGroups = async db => JSON.parse((await one(db, "SELECT value FROM metadata WHERE `key` = 'deleted-groups'"))?.value ?? '{}');
const saveArchivedGroups = (db, groups) => db.query("INSERT INTO metadata (`key`, value) VALUES ('deleted-groups', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(groups)]);

async function groupName(db, id) {
  const names = [];
  for (let group = id ? await findGroup(db, id) : null; group; group = group.parentId ? await findGroup(db, group.parentId) : null) names.unshift(group.name);
  return names.join(' / ') || '미분류';
}

async function recordHistory(db, id, action, actor, before, after, backupFile, now) {
  if (before) before = { ...before, groupName: before.groupName ?? await groupName(db, before.groupId) };
  after = { ...after, groupName: await groupName(db, after.groupId) };
  await db.query('INSERT INTO history (site_id, action, actor_id, actor_name, changed_at, before_data, after_data, backup_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, action, actor.id, actor.name, now, before ? JSON.stringify(before) : null, JSON.stringify(after), backupFile]);
}

async function snapshot(db, backupDir, action) {
  const filename = new Date().toISOString().replaceAll(':', '-') + '_' + action + '_' + randomUUID() + '.json';
  const target = join(backupDir, filename);
  try {
    const backup = await exportRows(db);
    const file = await open(target + '.tmp', 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(backup)); await file.sync(); } finally { await file.close(); }
    await rename(target + '.tmp', target);
    return filename;
  } catch {
    await unlink(target + '.tmp').catch(() => {});
    throw new HttpError(503, '변경 전 백업에 실패하여 저장하지 않았습니다. 서버의 백업 폴더와 여유 공간을 확인해 주세요.');
  }
}

export async function createMariaStore({ backupDir, database }) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const pool = createPool(database);
  const checkReady = async () => {
    const rows = await pool.query({ sql: "SELECT `key`, value FROM metadata WHERE `key` IN ('schema_version', 'initialized')", timeout: 2000 });
    if (rows.find(row => row.key === 'schema_version')?.value !== schemaVersion || !rows.some(row => row.key === 'initialized')) {
      throw new Error('MariaDB 스키마 적용과 데이터 이전을 먼저 완료해 주세요.');
    }
  };
  try { await checkReady(); } catch (error) { await pool.end(); throw error; }
  return {
    checkReady,
    list: async () => (await pool.query(siteQuery + ' ORDER BY sites.id')).map(rowToSite),
    find: id => find(pool, id),
    listGroups: () => listGroups(pool),
    userByUsername: username => one(pool, 'SELECT * FROM users WHERE username_key = ?', [caseKey(username)]),
    userForSession: (token, now) => one(pool, 'SELECT users.id, users.username, users.name, users.job_title AS jobTitle FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?', [token, now]),
    async createSession(token, userId, expiresAt, oldToken, now) {
      const db = await pool.getConnection();
      try {
        await transaction(db, async () => {
          await db.query('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?', [now, oldToken]);
          await db.query('INSERT INTO sessions VALUES (?, ?, ?)', [token, userId, expiresAt]);
        });
      } finally { db.release(); }
    },
    deleteSession: token => pool.query('DELETE FROM sessions WHERE token_hash = ?', [token]),
    async consumeLoginAttempt(address, now) {
      const key = createHash('sha256').update(address ?? '').digest('hex');
      const db = await pool.getConnection();
      let count;
      try {
        await db.query('DELETE FROM login_attempts WHERE expires_at <= ?', [now]);
        count = await transaction(db, async () => {
          await db.query('INSERT INTO login_attempts VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE attempts = IF(expires_at <= ?, 1, attempts + 1), expires_at = IF(expires_at <= ?, VALUES(expires_at), expires_at)', [key, now + 15 * 60 * 1000, now, now]);
          return (await one(db, 'SELECT attempts FROM login_attempts WHERE address = ?', [key])).attempts;
        });
      } finally { db.release(); }
      if (count > 30) throw new HttpError(429, '로그인 또는 가입 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.');
    },
    createUser({ username, name, jobTitle }, passwordHash) {
      return withWriteLock(pool, async db => {
        if (await one(db, 'SELECT id FROM users WHERE username_key = ?', [caseKey(username)])) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
        if (await one(db, 'SELECT id FROM users WHERE name_key = ?', [caseKey(name)])) throw new HttpError(409, '이미 사용 중인 이름입니다. 동명이인은 구분할 수 있는 이름을 사용해 주세요.');
        await snapshot(db, backupDir, 'signup');
        return transaction(db, async () => {
          const result = await db.query('INSERT INTO users (username, username_key, name, name_key, job_title, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, caseKey(username), name, caseKey(name), jobTitle, passwordHash, new Date().toISOString()]);
          return { id: result.insertId, username, name, jobTitle };
        });
      });
    },
    updateProfile(id, input) {
      return withWriteLock(pool, async db => {
        const profile = validateProfile(input);
        const old = await one(db, 'SELECT id, username, name, job_title AS jobTitle FROM users WHERE id = ?', [id]);
        if (!old) throw new HttpError(401, '다시 로그인해 주세요.');
        if (await one(db, 'SELECT id FROM users WHERE name_key = ? AND id <> ?', [caseKey(profile.name), id])) throw new HttpError(409, '이미 사용 중인 이름입니다. 동명이인은 구분할 수 있는 이름을 사용해 주세요.');
        if (old.name === profile.name && old.jobTitle === profile.jobTitle) return { user: old, changed: false };
        await snapshot(db, backupDir, 'profile');
        await transaction(db, () => db.query('UPDATE users SET name = ?, name_key = ?, job_title = ? WHERE id = ?', [profile.name, caseKey(profile.name), profile.jobTitle, id]));
        return { user: { ...old, ...profile }, changed: true };
      });
    },
    moveSite(id, input, actor) {
      return withWriteLock(pool, async db => {
        const all = (await db.query(siteQuery + ' ORDER BY sites.id')).map(rowToSite);
        const plan = planSiteMove(all, id, input);
        if (input.groupId && !await findGroup(db, input.groupId)) throw new HttpError(400, '그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
        if (!plan.length) return { site: await find(db, id), changed: false };
        const backupFile = await snapshot(db, backupDir, 'move');
        return transaction(db, async () => {
          const now = new Date().toISOString();
          for (const item of plan) {
            if (!item.changed) {
              await db.query('UPDATE sites SET data = ? WHERE id = ?', [JSON.stringify(item.next), item.old.id]);
              continue;
            }
            const result = await db.query('UPDATE sites SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?', [JSON.stringify(item.next), now, actor.name, item.old.id, item.old.version]);
            if (result.affectedRows !== 1) throw new HttpError(409, '시스템이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
            const before = { ...Object.fromEntries(fields.map(field => [field, item.old[field]])), position: item.beforePosition, deleted: false };
            await recordHistory(db, item.old.id, 'move', actor, before, { ...item.next, position: item.afterPosition, deleted: false }, backupFile, now);
          }
          return { site: await find(db, id), changed: true };
        });
      });
    },
    mutate(action, id, input, actor) {
      return withWriteLock(pool, async db => {
        const old = id ? await find(db, id) : null;
        if (action !== 'create' && (!old || old.deletedAt)) throw new HttpError(404, '이미 삭제되었거나 존재하지 않는 항목입니다.');
        if (old && input.version !== old.version) throw new HttpError(409, '다른 사람이 먼저 변경했습니다. 입력 내용을 보관한 뒤 목록을 새로고침하고 다시 수정해 주세요.');
        const next = action === 'delete' ? Object.fromEntries(fields.map(field => [field, old[field]])) : validateSite({ ...input, groupId: input.groupId === undefined ? old?.groupId : input.groupId, components: input.components === undefined ? old?.components : input.components });
        if (next.groupId && !await findGroup(db, next.groupId)) throw new HttpError(400, '그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
        if (action === 'update' && fields.every(field => field === 'components' ? JSON.stringify(next[field]) === JSON.stringify(old[field]) : next[field] === old[field])) return { site: old, changed: false };
        next.treeOrder = old && old.groupId === next.groupId ? old.treeOrder : Math.max(0, ...(await db.query(siteQuery + ' WHERE deleted_at IS NULL')).map(rowToSite).filter(site => site.groupId === next.groupId).map(site => site.treeOrder)) + 1;
        const backupFile = await snapshot(db, backupDir, action);
        return transaction(db, async () => {
          const now = new Date().toISOString();
          if (action === 'create') {
            id = (await db.query('INSERT INTO sites (data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?)', [JSON.stringify(next), now, now, actor.name])).insertId;
          } else {
            const result = await db.query('UPDATE sites SET data = ?, version = version + 1, updated_at = ?, updated_by = ?, deleted_at = ? WHERE id = ? AND version = ?',
              [JSON.stringify(next), now, actor.name, action === 'delete' ? now : null, id, input.version]);
            if (result.affectedRows !== 1) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침해 주세요.');
          }
          const before = old ? { ...Object.fromEntries(fields.map(field => [field, old[field]])), deleted: false } : null;
          await recordHistory(db, id, action, actor, before, { ...next, deleted: action === 'delete' }, backupFile, now);
          return { site: await find(db, id), changed: true };
        });
      });
    },
    moveGroup(id, input) {
      return withWriteLock(pool, async db => {
        const plan = planGroupMove(await listGroups(db), id, input);
        if (!plan) return { group: (await listGroups(db)).find(group => group.id === id), changed: false };
        await snapshot(db, backupDir, 'group-move');
        return transaction(db, async () => {
          for (const group of plan.updates) {
            const result = await db.query('UPDATE `groups` SET parent_id = ?, parent_key = ?, version = version + 1 WHERE id = ? AND version = ?', [group.parentId, group.parentId ?? 0, group.id, group.version]);
            if (result.affectedRows !== 1) throw new HttpError(409, '그룹이 변경되었습니다. 목록을 새로고침한 뒤 다시 이동해 주세요.');
          }
          await saveGroupOrder(db, plan.order);
          return { group: (await listGroups(db)).find(group => group.id === id), changed: true };
        });
      });
    },
    mutateGroup(action, id, input) {
      return withWriteLock(pool, async db => {
        const old = id ? await findGroup(db, id) : null;
        if (action !== 'create' && !old) throw new HttpError(404, '그룹을 찾을 수 없습니다.');
        if (old && input.version !== old.version) throw new HttpError(409, '다른 사람이 그룹을 변경했습니다. 목록을 새로고침한 뒤 다시 수정해 주세요.');
        const currentGroups = await listGroups(db);
        let name, parentId, removed;
        if (action === 'delete') {
          removed = planGroupDelete(currentGroups, (await db.query(siteQuery)).map(rowToSite), id);
        } else {
          name = typeof input.name === 'string' ? input.name.normalize('NFKC').trim() : '';
          if (!name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, '그룹명은 1~100자로 입력해 주세요.');
          parentId = validateGroupId(input.parentId);
          if (parentId && !await findGroup(db, parentId)) throw new HttpError(400, '상위 그룹이 존재하지 않습니다. 목록을 새로고침해 주세요.');
          for (let parent = parentId ? await findGroup(db, parentId) : null; parent; parent = parent.parentId ? await findGroup(db, parent.parentId) : null) {
            if (parent.id === id) throw new HttpError(400, '자기 자신이나 하위 그룹을 상위 그룹으로 지정할 수 없습니다.');
          }
          const duplicate = await one(db, 'SELECT id FROM `groups` WHERE parent_key = ? AND name_key = ?', [parentId ?? 0, caseKey(name)]);
          if (duplicate && duplicate.id !== id) throw new HttpError(409, '같은 위치에 동일한 이름의 그룹이 있습니다.');
          if (old && old.name === name && old.parentId === parentId) return { group: (await listGroups(db)).find(group => group.id === id), changed: false };
        }
        await snapshot(db, backupDir, 'group-' + action);
        return transaction(db, async () => {
          if (action === 'delete') {
            const order = await readGroupOrder(db);
            const archived = await readArchivedGroups(db);
            for (const group of removed) {
              archived[group.id] = group;
              const result = await db.query('DELETE FROM `groups` WHERE id = ? AND version = ?', [group.id, group.version]);
              if (result.affectedRows !== 1) throw new HttpError(409, '그룹이 변경되었습니다. 목록을 새로고침해 주세요.');
              delete order[group.id];
            }
            await saveArchivedGroups(db, archived); await saveGroupOrder(db, order);
            return { changed: true };
          }
          if (action === 'create') id = (await db.query('INSERT INTO `groups` (name, name_key, parent_id, parent_key) VALUES (?, ?, ?, ?)', [name, caseKey(name), parentId, parentId ?? 0])).insertId;
          else {
            const result = await db.query('UPDATE `groups` SET name = ?, name_key = ?, parent_id = ?, parent_key = ?, version = version + 1 WHERE id = ? AND version = ?', [name, caseKey(name), parentId, parentId ?? 0, id, input.version]);
            if (result.affectedRows !== 1) throw new HttpError(409, '그룹이 변경되었습니다. 목록을 새로고침해 주세요.');
          }
          if (old && old.parentId !== parentId || action === 'create' && Object.keys(await readGroupOrder(db)).length) {
            const order = groupOrderMap(currentGroups);
            order[id] = currentGroups.filter(group => group.parentId === parentId && group.id !== id).length + 1;
            await saveGroupOrder(db, order);
          }
          return { group: (await listGroups(db)).find(group => group.id === id), changed: true };
        });
      });
    },
    async history(id) {
      if (!await find(pool, id)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
      return (await pool.query(`SELECT history.*, COALESCE(users.job_title, '') AS actor_job_title
        FROM history LEFT JOIN users ON users.id = history.actor_id
        WHERE history.site_id = ? ORDER BY history.id DESC`, [id])).map(row => ({
        id: row.id, action: row.action, actor: row.actor_name, actorJobTitle: row.actor_job_title, changedAt: row.changed_at,
        before: row.before_data ? JSON.parse(row.before_data) : null, after: JSON.parse(row.after_data), backupFile: row.backup_file,
      }));
    },
    restoreSite(id, input, actor) {
      return withWriteLock(pool, async db => {
        const old = await find(db, id);
        if (!old) throw new HttpError(404, '이미 완전 삭제되었거나 존재하지 않는 항목입니다.');
        if (!old.deletedAt) throw new HttpError(409, '삭제된 시스템만 복구할 수 있습니다.');
        if (input.version !== old.version) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.');
        const currentGroups = await listGroups(db);
        const plan = planGroupRestore(currentGroups, await readArchivedGroups(db), old.groupId);
        const backupFile = await snapshot(db, backupDir, 'restore');
        return transaction(db, async () => {
          const order = groupOrderMap(currentGroups);
          for (const group of plan.created) {
            await db.query('INSERT INTO `groups` (id, name, name_key, parent_id, parent_key, version) VALUES (?, ?, ?, ?, ?, ?)', [group.id, group.name, caseKey(group.name), group.parentId, group.parentId ?? 0, group.version]);
            order[group.id] = currentGroups.filter(item => item.parentId === group.parentId).length + 1;
            currentGroups.push(group);
          }
          if (plan.created.length) await saveGroupOrder(db, order);
          await saveArchivedGroups(db, plan.archived);
          const next = { ...Object.fromEntries(fields.map(field => [field, old[field]])), groupId: plan.groupId };
          next.treeOrder = Math.max(0, ...(await db.query(siteQuery + ' WHERE deleted_at IS NULL')).map(rowToSite).filter(site => site.groupId === next.groupId).map(site => site.treeOrder)) + 1;
          const now = new Date().toISOString();
          const result = await db.query('UPDATE sites SET data = ?, version = version + 1, updated_at = ?, updated_by = ?, deleted_at = NULL WHERE id = ? AND version = ?', [JSON.stringify(next), now, actor.name, id, input.version]);
          if (result.affectedRows !== 1) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침해 주세요.');
          const restoredGroupName = await groupName(db, next.groupId);
          await recordHistory(db, id, 'restore', actor, { ...Object.fromEntries(fields.map(field => [field, old[field]])), deleted: true, groupName: restoredGroupName }, { ...next, deleted: false }, backupFile, now);
          return { site: await find(db, id), changed: true, groupRestored: plan.created.length > 0, groupName: restoredGroupName };
        });
      });
    },
    permanentlyDelete(id, input) {
      return withWriteLock(pool, async db => {
        const old = await find(db, id);
        if (!old) throw new HttpError(404, '이미 완전 삭제되었거나 존재하지 않는 항목입니다.');
        if (!old.deletedAt) throw new HttpError(409, '삭제된 목록의 항목만 완전 삭제할 수 있습니다.');
        if (input.version !== old.version) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.');
        await snapshot(db, backupDir, 'permanent-delete');
        return transaction(db, async () => {
          await db.query('DELETE FROM history WHERE site_id = ?', [id]);
          const result = await db.query('DELETE FROM sites WHERE id = ? AND version = ?', [id, input.version]);
          if (result.affectedRows !== 1) throw new HttpError(409, '항목이 변경되었습니다. 목록을 새로고침해 주세요.');
          return { changed: true };
        });
      });
    },
    close: () => pool.end(),
  };
}
