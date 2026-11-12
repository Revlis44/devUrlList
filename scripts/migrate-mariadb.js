import { createPool } from '../lib/mariadb.js';
import { migrateSchema } from '../lib/mariadb-migration.js';

const pool = createPool();
try { await migrateSchema(pool); console.log('MariaDB 스키마 적용 완료'); }
catch (error) { console.error('스키마 적용 실패:', error.code ?? error.message); process.exitCode = 1; }
finally { await pool.end(); }
