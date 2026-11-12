import { createPool } from '../lib/mariadb.js';
const pool = createPool();
try {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await pool.query('SELECT 1'); lastError = null; break; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (lastError) throw new Error('테스트 MariaDB 시작 시간 초과');
} finally { await pool.end(); }
