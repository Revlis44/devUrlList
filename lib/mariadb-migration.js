import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { columns, quote, caseKey, schemaVersion, transaction, withWriteLock } from './mariadb.js';
import { planGroupRestore } from './store.js';

export async function migrateSchema(pool) {
  await withWriteLock(pool, async db => {
    const exists = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'metadata'");
    if (exists.length) {
      const [version] = await db.query("SELECT value FROM metadata WHERE `key` = 'schema_version'");
      if (version && version.value !== schemaVersion) throw new Error('지원하지 않는 DB 스키마 버전입니다.');
    }
    const sql = await readFile(new URL('../db/migrations/001-initial.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.query(statement);
    await db.query("INSERT INTO metadata (`key`, value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [schemaVersion]);
  });
}

export function readSQLiteSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 무결성 검사에 실패했습니다.');
    const tables = {};
    for (const [table, names] of Object.entries(columns)) {
      tables[table] = table === 'login_attempts' ? [] : db.prepare('SELECT ' + names.map(quote).join(',') + ' FROM ' + quote(table)).all();
    }
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'groups'").get()?.seq ?? 0;
    db.exec('COMMIT');
    return { format: 'devurllist-mariadb-v1', tables, sequences: { groups: sequence + 1 } };
  } finally { db.close(); }
}

const canonical = (rows, names) => JSON.stringify(rows.map(row => names.map(name => row[name])).sort((a, b) =>
  typeof a[0] === 'number' ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]), 'en')));

function validateSnapshot(snapshot) {
  if (snapshot.format !== 'devurllist-mariadb-v1') throw new Error('지원하지 않는 백업 형식입니다.');
  for (const [table, names] of Object.entries(columns)) {
    if (!Array.isArray(snapshot.tables?.[table])) throw new Error('백업 테이블이 누락되었습니다: ' + table);
    for (const row of snapshot.tables[table]) {
      if (!row || names.some(name => !Object.hasOwn(row, name))) throw new Error('백업 컬럼이 누락되었습니다: ' + table);
      for (const name of ['id', 'version', 'expires_at']) {
        if (Object.hasOwn(row, name) && (!Number.isSafeInteger(row[name]) || row[name] < 0)) throw new Error('백업 숫자 범위를 확인해 주세요.');
      }
    }
  }
  if (!snapshot.tables.metadata.some(row => row.key === 'initialized')) throw new Error('초기화된 SQLite 또는 MariaDB 백업을 사용해 주세요.');
  const version = snapshot.tables.metadata.find(row => row.key === 'schema_version');
  if (version && version.value !== schemaVersion) throw new Error('지원하지 않는 백업 스키마 버전입니다.');
  const groups = new Map(snapshot.tables.groups.map(row => [row.id, row]));
  for (const group of groups.values()) {
    const seen = new Set([group.id]);
    let parentId = group.parent_id;
    while (parentId !== null) {
      if (!groups.has(parentId) || seen.has(parentId)) throw new Error('그룹의 부모 관계가 올바르지 않습니다.');
      seen.add(parentId); parentId = groups.get(parentId).parent_id;
    }
  }
  const archived = JSON.parse(snapshot.tables.metadata.find(row => row.key === 'deleted-groups')?.value ?? '{}');
  for (const row of snapshot.tables.sites) {
    const data = JSON.parse(row.data);
    if (data.groupId != null && !groups.has(data.groupId)) {
      if (!row.deleted_at) throw new Error('시스템의 그룹 관계가 올바르지 않습니다.');
      planGroupRestore(snapshot.tables.groups.map(group => ({ ...group, parentId: group.parent_id })), archived, data.groupId);
    }
  }
}

export async function importSnapshot(pool, snapshot) {
  validateSnapshot(snapshot);
  return withWriteLock(pool, async db => {
    const [version] = await db.query("SELECT value FROM metadata WHERE `key` = 'schema_version'");
    if (version?.value !== schemaVersion) throw new Error('먼저 DB 스키마를 적용해 주세요.');
    for (const table of Object.keys(columns)) {
      const [row] = await db.query('SELECT COUNT(*) AS count FROM ' + quote(table) + (table === 'metadata' ? " WHERE `key` <> 'schema_version'" : ''));
      if (row.count) throw new Error('대상 DB가 비어 있지 않아 이전을 중단했습니다.');
    }
    for (const table of ['users', 'groups', 'sites', 'history']) {
      const nextId = snapshot.sequences?.[table] ?? 1;
      if (!Number.isSafeInteger(nextId) || nextId < 1) throw new Error('백업 자동 증가 번호가 올바르지 않습니다.');
      await db.query('ALTER TABLE ' + quote(table) + ' AUTO_INCREMENT = ' + nextId);
    }
    return transaction(db, async () => {
      const report = {};
      for (const [table, names] of Object.entries(columns)) {
        const rows = snapshot.tables[table].filter(row => table !== 'metadata' || row.key !== 'schema_version');
        for (const row of rows) {
          const values = Object.fromEntries(names.map(name => [name, row[name]]));
          if (table === 'users') {
            values.name_key = caseKey(row.name);
            values.username_key = row.username === null ? null : caseKey(row.username);
          }
          if (table === 'groups') {
            values.parent_id = null;
            values.parent_key = row.parent_id ?? 0;
            values.name_key = caseKey(row.name);
          }
          const keys = Object.keys(values);
          await db.query('INSERT INTO ' + quote(table) + ' (' + keys.map(quote).join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')', Object.values(values));
        }
        if (table === 'groups') {
          for (const row of rows) await db.query('UPDATE `groups` SET parent_id = ? WHERE id = ?', [row.parent_id, row.id]);
        }
        const actual = await db.query('SELECT ' + names.map(quote).join(',') + ' FROM ' + quote(table) + (table === 'metadata' ? " WHERE `key` <> 'schema_version'" : ''));
        const expected = canonical(rows, names);
        if (canonical(actual, names) !== expected) throw new Error('이전 데이터 검증에 실패했습니다: ' + table);
        report[table] = { count: rows.length, sha256: createHash('sha256').update(expected).digest('hex') };
      }
      return report;
    });
  });
}
