import { readFile } from 'node:fs/promises';
import { createPool } from '../lib/mariadb.js';
import { readSQLiteSnapshot, importSnapshot } from '../lib/mariadb-migration.js';

const [kind, path, extra] = process.argv.slice(2);
if (!['--sqlite', '--backup'].includes(kind) || !path || extra) {
  console.error('사용법: node scripts/import-mariadb.js --sqlite /안전한/스냅샷.sqlite | --backup /안전한/백업.json');
  process.exitCode = 1;
} else {
  const pool = createPool();
  try {
    const snapshot = kind === '--sqlite' ? readSQLiteSnapshot(path) : JSON.parse(await readFile(path, 'utf8'));
    console.log(JSON.stringify(await importSnapshot(pool, snapshot), null, 2));
  } catch (error) { console.error('이전 실패:', error.code ?? error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
