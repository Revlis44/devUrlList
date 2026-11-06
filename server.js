import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createStore, HttpError } from './lib/store.js';

const root = dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(scryptCallback);
const sessionAge = 12 * 60 * 60;
const digest = token => createHash('sha256').update(token).digest('hex');

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = (stored ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

async function readJson(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON 형식으로 요청해 주세요.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, '입력 내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, '입력 내용을 확인해 주세요.'); }
}

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(root, 'data'));
  const backupDir = resolve(options.backupDir ?? process.env.BACKUP_DIR ?? join(root, 'backups'));
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  const appOrigin = (options.appOrigin ?? process.env.APP_ORIGIN) || undefined;
  if (appOrigin && new URL(appOrigin).origin !== appOrigin) throw new Error('APP_ORIGIN은 경로 없이 입력하세요. 예: https://servers.example.com');
  const store = createStore({ dataDir, backupDir, seed: options.seed ?? JSON.parse(readFileSync(join(root, 'seed.example.json'), 'utf8')) });
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.png', ['favicon.png', 'image/png']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ]);
  const attempts = new Map();
  function rateLimit(req) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const item = attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
    item.count++;
    attempts.set(key, item);
    if (item.count > 30) throw new HttpError(429, '로그인 또는 가입 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.');
  }
  function tokenFrom(req) {
    return (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('devsites_session='))?.slice(17) ?? '';
  }
  function userFrom(req) {
    const token = tokenFrom(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return store.db.prepare('SELECT users.id, users.username, users.name, users.job_title AS jobTitle FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(digest(token), Date.now()) ?? null;
  }
  function setSession(req, res, user) {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').run(Date.now(), digest(tokenFrom(req)));
    store.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + sessionAge * 1000);
    res.setHeader('Set-Cookie', `devsites_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge}${secureCookie ? '; Secure' : ''}`);
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '지원하지 않는 요청입니다.');
        const asset = assets.get(pathname);
        if (!asset) throw new HttpError(404, '페이지를 찾을 수 없습니다.');
        const bytes = readFileSync(join(root, 'public', asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, '지원하지 않는 요청입니다.');
      if (req.method !== 'GET') {
        const expectedOrigin = appOrigin ?? `http${secureCookie ? 's' : ''}://${req.headers.host}`;
        if (req.headers['x-requested-with'] !== 'dev-site-list' || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== expectedOrigin)) {
          throw new HttpError(403, '요청 출처를 확인할 수 없습니다. 페이지를 새로고침해 주세요.');
        }
      }
      if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { user: userFrom(req) });
      if (['/api/register', '/api/login'].includes(pathname) && req.method === 'POST') {
        rateLimit(req);
        const body = await readJson(req);
        const username = typeof body.username === 'string' ? body.username.normalize('NFKC').trim() : '';
        const password = body.password;
        if (!username || username.length > 40 || /[\s\p{Cc}\p{Cf}]/u.test(username)) throw new HttpError(400, '아이디는 공백 없이 1~40자로 입력해 주세요.');
        if (typeof password !== 'string' || password.length > 128 || !password.trim()) throw new HttpError(400, '비밀번호는 공백만 사용하지 않고 1~128자로 입력해 주세요.');
        let user;
        if (pathname === '/api/register') {
          const name = typeof body.name === 'string' ? body.name.normalize('NFKC').trim() : '';
          const jobTitle = typeof body.jobTitle === 'string' ? body.jobTitle.normalize('NFKC').trim() : '';
          if (name.length < 2 || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, '이름은 2~40자로 입력해 주세요.');
          if (!jobTitle || jobTitle.length > 40 || /[\p{Cc}\p{Cf}]/u.test(jobTitle)) throw new HttpError(400, '직급은 1~40자로 입력해 주세요.');
          user = await store.createUser({ username, name, jobTitle }, await hashPassword(password));
        } else {
          const found = store.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
          const valid = await verifyPassword(password, found?.password_hash);
          if (!found || !valid) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
          user = { id: found.id, username: found.username, name: found.name, jobTitle: found.job_title };
        }
        setSession(req, res, user);
        return json(res, pathname === '/api/register' ? 201 : 200, { user });
      }
      const user = userFrom(req);
      if (!user) throw new HttpError(401, '로그인이 필요합니다. 다시 로그인해 주세요.');
      if (pathname === '/api/logout' && req.method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(tokenFrom(req)));
        res.setHeader('Set-Cookie', `devsites_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/sites' && req.method === 'GET') return json(res, 200, { sites: store.list() });
      if (pathname === '/api/sites' && req.method === 'POST') return json(res, 201, await store.mutate('create', null, await readJson(req), user));
      const match = pathname.match(/^\/api\/sites\/(\d+)(\/history)?$/);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
        if (match[2] && req.method === 'GET') return json(res, 200, { history: store.history(id) });
        if (!match[2] && ['PUT', 'DELETE'].includes(req.method)) {
          return json(res, 200, await store.mutate(req.method === 'PUT' ? 'update' : 'delete', id, await readJson(req), user));
        }
      }
      throw new HttpError(404, '요청한 기능을 찾을 수 없습니다.');
    } catch (error) {
      if (!error.status) console.error('요청 처리 실패:', error.code ?? error.name);
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, store, async close() { await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); await store.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const app = createApp();
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, host, () => console.log(`개발서버 목록: http://${host}:${app.server.address().port}`));
  app.server.on('error', error => { console.error('서버 시작 실패:', error.code); process.exitCode = 1; app.store.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
}
