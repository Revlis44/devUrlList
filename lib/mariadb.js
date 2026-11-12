import mariadb from 'mariadb';
import { HttpError } from './store.js';

export const schemaVersion = '1';
export const columns = {
  metadata: ['key', 'value'],
  users: ['id', 'name', 'password_hash', 'created_at', 'username', 'job_title'],
  groups: ['id', 'name', 'parent_id', 'version'],
  sites: ['id', 'data', 'version', 'created_at', 'updated_at', 'updated_by', 'deleted_at'],
  history: ['id', 'site_id', 'action', 'actor_id', 'actor_name', 'changed_at', 'before_data', 'after_data', 'backup_file'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  login_attempts: ['address', 'attempts', 'expires_at'],
};
export const quote = name => '`' + name + '`';
export const caseKey = value => Buffer.from(value.replace(/[A-Z]/g, char => char.toLowerCase()), 'utf8');

export function databaseConfig(env = process.env) {
  for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[name]) throw new Error(name + ' 설정이 필요합니다.');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(env.DB_NAME)) throw new Error('DB_NAME 형식을 확인해 주세요.');
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD };
}

export function createPool(config = databaseConfig()) {
  return mariadb.createPool({ ...config, connectionLimit: 5, connectTimeout: 3000, acquireTimeout: 5000,
    queryTimeout: 30000, bigIntAsNumber: true, insertIdAsNumber: true, checkNumberRange: true,
    autoJsonMap: false, charset: 'utf8mb4', timezone: 'Z' });
}

export async function transaction(connection, action) {
  await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await connection.beginTransaction();
  try { const result = await action(); await connection.commit(); return result; }
  catch (error) { await connection.rollback(); throw error; }
}

export async function withWriteLock(pool, action) {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [row] = await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':devurllist-write'), 30) AS locked");
    if (row.locked !== 1) throw new HttpError(503, '다른 변경을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    locked = true;
    return await action(connection);
  } finally {
    try {
      if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':devurllist-write'))");
    } catch { connection.destroy(); }
    connection.release();
  }
}

export async function exportRows(connection) {
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    const tables = {};
    for (const [table, names] of Object.entries(columns)) {
      tables[table] = await connection.query('SELECT ' + names.map(quote).join(',') + ' FROM ' + quote(table) + ' ORDER BY ' + quote(names[0]));
    }
    const sequences = {};
    for (const row of await connection.query("SELECT TABLE_NAME AS name, AUTO_INCREMENT AS nextId FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND AUTO_INCREMENT IS NOT NULL")) {
      if (Object.hasOwn(columns, row.name)) sequences[row.name] = row.nextId;
    }
    await connection.commit();
    return { format: 'devurllist-mariadb-v1', createdAt: new Date().toISOString(), tables, sequences };
  } catch (error) { await connection.rollback(); throw error; }
}
