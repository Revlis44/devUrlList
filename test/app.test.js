import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, rename, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';

async function setup(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-test-'));
  const dataDir = join(folder, 'data');
  const backupDir = join(folder, 'backups');
  const app = createApp({ dataDir, backupDir, seed: [], ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '';
    return async (path, method = 'GET', body, headers = {}) => {
      const response = await fetch(base + path, {
        method, headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'dev-site-list', Origin: base }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
  };
  return { ...app, folder, dataDir, backupDir, base, client };
}

const sample = { systemName: '검증 서버', url: 'https://example.internal', commonAccount: 'tester / sample-password', ip: '192.168.1.20', servicePort: '8080, 443', sshPort: '22', serverAccount: 'dev', externalAccess: 'no', notes: '최초 값' };
const credentials = { username: 'test-user', name: '검증 사용자', jobTitle: '대리', password: 'OnlyTestPassword123!' };

test('로그인, 두 사용자 변경 이력, 실제 변경 전 백업, 삭제 보관, 세션 종료', async t => {
  const { client, store, backupDir } = await setup(t);
  const first = client(); const second = client();
  assert.equal((await first('/api/sites')).status, 401);
  assert.equal((await first('/api/sites/1/history')).status, 401);
  const registered = await first('/api/register', 'POST', credentials);
  assert.equal(registered.status, 201);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const user = store.db.prepare('SELECT * FROM users').get();
  assert.notEqual(user.password_hash, credentials.password);
  assert.equal(user.password_hash.includes(credentials.password), false);
  assert.equal((await second('/api/register', 'POST', credentials)).status, 409);
  assert.equal((await second('/api/login', 'POST', { ...credentials, password: 'WrongPassword123!' })).status, 401);
  assert.equal((await second('/api/register', 'POST', { username: 'second-user', name: '두 번째 사용자', jobTitle: '과장', password: 'OtherTestPassword123!' })).status, 201);
  assert.equal((await first('/api/me')).body.user.name, credentials.name);
  const created = await first('/api/sites', 'POST', sample);
  assert.equal(created.status, 201);
  assert.equal(created.body.site.updatedByJobTitle, '대리');
  const id = created.body.site.id;
  const updated = await second(`/api/sites/${id}`, 'PUT', { ...sample, notes: '다른 사용자가 수정', version: 1 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.site.version, 2);
  assert.equal(updated.body.site.updatedByJobTitle, '과장');
  assert.equal((await first(`/api/sites/${id}`, 'PUT', { ...sample, notes: '오래된 화면', version: 1 })).status, 409);
  const noChange = await second(`/api/sites/${id}`, 'PUT', { ...sample, notes: '다른 사용자가 수정', version: 2 });
  assert.equal(noChange.body.changed, false);
  const history = (await first(`/api/sites/${id}/history`)).body.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].actor, '두 번째 사용자');
  assert.equal(history[0].actorJobTitle, '과장');
  assert.equal(history[1].actorJobTitle, '대리');
  assert.equal(history[0].before.notes, '최초 값');
  assert.equal(history[0].after.notes, '다른 사용자가 수정');
  assert.ok(!Number.isNaN(Date.parse(history[0].changedAt)));
  const beforeUpdate = new DatabaseSync(join(backupDir, history[0].backupFile), { readOnly: true });
  assert.equal(beforeUpdate.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(JSON.parse(beforeUpdate.prepare('SELECT data FROM sites WHERE id = ?').get(id).data).notes, '최초 값');
  assert.equal(beforeUpdate.prepare('SELECT count(*) AS count FROM history').get().count, 1);
  beforeUpdate.close();
  assert.equal((await first(`/api/sites/${id}`, 'DELETE', { version: 1 })).status, 409);
  assert.equal((await first(`/api/sites/${id}`, 'DELETE', { version: 2 })).status, 200);
  const listed = (await first('/api/sites')).body.sites;
  assert.equal(listed.length, 1); assert.ok(listed[0].deletedAt);
  assert.equal(listed[0].updatedByJobTitle, '대리');
  assert.equal((await first(`/api/sites/${id}`, 'PUT', { ...sample, version: 3 })).status, 404);
  const deletedHistory = (await first(`/api/sites/${id}/history`)).body.history;
  assert.equal(deletedHistory.length, 3);
  assert.equal(deletedHistory[0].action, 'delete');
  assert.equal(deletedHistory[0].actorJobTitle, '대리');
  assert.equal(deletedHistory[0].after.deleted, true);
  assert.equal((await readdir(backupDir)).filter(file => file.endsWith('.sqlite')).length, 5);
  assert.equal((await first('/api/logout', 'POST', {})).status, 200);
  assert.equal((await first('/api/sites')).status, 401);
  assert.equal((await first('/api/login', 'POST', credentials)).status, 200);
});

test('짧은 비밀번호와 최대 길이 비밀번호로 가입, 로그아웃 후 재로그인', async t => {
  const { client } = await setup(t);
  for (const length of [1, 3, 7, 128]) {
    const request = client();
    const account = { username: `length-${length}`, name: `길이 ${length} 검증`, jobTitle: '사원', password: '1'.repeat(length) };
    assert.equal((await request('/api/register', 'POST', account)).status, 201);
    assert.equal((await request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/login', 'POST', { ...account, password: '2' })).status, 401);
    assert.equal((await request('/api/login', 'POST', account)).status, 200);
    assert.equal((await request('/api/me')).body.user.name, account.name);
  }
});

test('아이디로 가입·로그인하고 이름·직급을 반환, 중복 아이디 차단', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  const account = { username: 'member.one', name: '홍길동', jobTitle: '대리', password: '1' };
  const registered = await request('/api/register', 'POST', account);
  assert.equal(registered.status, 201);
  const expected = { id: registered.body.user.id, username: account.username, name: account.name, jobTitle: account.jobTitle };
  assert.deepEqual(registered.body.user, expected);
  assert.deepEqual((await request('/api/me')).body.user, expected);
  assert.equal(store.db.prepare('SELECT job_title FROM users WHERE username = ?').get(account.username).job_title, account.jobTitle);
  const duplicate = await client()('/api/register', 'POST', { ...account, username: 'MEMBER.ONE', name: '다른 사용자' });
  assert.equal(duplicate.status, 409);
  assert.equal((await readdir(backupDir)).length, 1);
  assert.equal((await request('/api/logout', 'POST', {})).status, 200);
  assert.equal((await request('/api/login', 'POST', { username: account.name, password: account.password })).status, 401);
  assert.equal((await request('/api/login', 'POST', { name: account.name, password: account.password })).status, 400);
  const loggedIn = await request('/api/login', 'POST', { username: 'MEMBER.ONE', password: account.password });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.body.user, expected);
});

test('가입 시 아이디·직급의 누락, 잘못된 형식과 길이를 거절', async t => {
  const { client, store } = await setup(t);
  const request = client();
  for (const patch of [
    { username: undefined }, { username: 123 }, { username: '' }, { username: 'user name' }, { username: 'user\u200b' }, { username: 'u'.repeat(41) },
    { jobTitle: undefined }, { jobTitle: 123 }, { jobTitle: '' }, { jobTitle: ' \t ' }, { jobTitle: '대\n리' }, { jobTitle: '직'.repeat(41) },
  ]) {
    assert.equal((await request('/api/register', 'POST', { ...credentials, ...patch })).status, 400);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
});

test('계정이 없는 기존 DB에 아이디·직급 항목 추가, 서버 목록과 이력 보존', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-schema-'));
  const config = { dataDir: join(folder, 'data'), backupDir: join(folder, 'backups'), seed: [sample] };
  const previous = createApp(config);
  const beforeSites = previous.store.list();
  const beforeHistory = previous.store.history(beforeSites[0].id);
  await previous.store.close();
  const legacy = new DatabaseSync(join(config.dataDir, 'sites.sqlite'));
  legacy.exec(`
    DROP TABLE users;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  legacy.close();
  const { store, client } = await setup(t, config);
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.deepEqual(store.list(), beforeSites);
  assert.deepEqual(store.history(beforeSites[0].id), beforeHistory);
  const request = client();
  assert.equal((await request('/api/register', 'POST', credentials)).status, 201);
  assert.equal((await request('/api/me')).body.user.jobTitle, credentials.jobTitle);
});

test('동시 수정은 하나만 성공하고 이전 값과 이력의 원자성을 유지', async t => {
  const { client, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  const results = await Promise.all([
    request(`/api/sites/${site.id}`, 'PUT', { ...sample, notes: '동시 변경 A', version: 1 }),
    request(`/api/sites/${site.id}`, 'PUT', { ...sample, notes: '동시 변경 B', version: 1 }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request(`/api/sites/${site.id}/history`)).body.history.length, 2);
  assert.equal((await readdir(backupDir)).length, 3);
});

test('백업 실패 시 목록과 이력이 모두 바뀌지 않음', async t => {
  const { client, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  await rename(backupDir, `${backupDir}-original`);
  await writeFile(backupDir, '백업 폴더 대신 파일을 두어 쓰기 실패 유도');
  const result = await request(`/api/sites/${site.id}`, 'PUT', { ...sample, notes: '저장되면 안 됨', version: 1 });
  assert.equal(result.status, 503);
  assert.equal((await request('/api/sites')).body.sites[0].notes, '최초 값');
  assert.equal((await request(`/api/sites/${site.id}/history`)).body.history.length, 1);
});

test('입력 검증, 출처 검증, DB와 백업 비공개, 기록의 사용자 위조 차단', async t => {
  const { client, base } = await setup(t);
  const request = client();
  for (const path of ['/api/register', '/api/login']) {
    for (const password of [undefined, null, 123, {}, '', ' \t ', '1'.repeat(129)]) {
      assert.equal((await request(path, 'POST', { ...credentials, password })).status, 400);
    }
  }
  assert.equal((await request('/api/register', 'POST', credentials, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/register', 'POST', credentials, { 'X-Requested-With': '' })).status, 403);
  assert.equal((await request('/api/register', 'POST', credentials)).status, 201);
  for (const patch of [{ url: 'javascript:alert(1)' }, { ip: '999.1.1.1' }, { sshPort: '65536' }, { systemName: '' }, { externalAccess: 'maybe' }, { commonAccount: {} }, { url: 'https://name:password@example.com' }]) {
    assert.equal((await request('/api/sites', 'POST', { ...sample, ...patch })).status, 400);
  }
  const result = await request('/api/sites', 'POST', { ...sample, actor: '위조된 이름', updatedBy: '위조된 이름' });
  assert.equal(result.body.site.updatedBy, credentials.name);
  for (const path of ['/data/sites.sqlite', '/backups/', '/seed.example.json', '/server.js', '/.env']) assert.equal((await fetch(base + path)).status, 404);
  const html = await fetch(base);
  assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
});

test('저장 실패 시 트랜잭션 롤백으로 목록과 이력의 불일치 방지', async t => {
  const { client, store } = await setup(t); const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  store.db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request(`/api/sites/${site.id}`, 'PUT', { ...sample, notes: '실패할 변경', version: 1 })).status, 500);
  assert.equal((await request('/api/sites')).body.sites[0].notes, '최초 값');
  assert.equal((await request(`/api/sites/${site.id}/history`)).body.history.length, 1);
});

test('재시작 후 사용자·목록·이력 유지, 초기 데이터는 한 번만 삽입', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-restart-'));
  const config = { dataDir: join(folder, 'data'), backupDir: join(folder, 'backups'), seed: [sample] };
  await mkdir(config.dataDir);
  let app = createApp(config);
  assert.equal(app.store.list().length, 1);
  const user = await app.store.createUser({ username: 'restart-user', name: '지속성 확인', jobTitle: '과장' }, 'not-used-for-login');
  await app.store.mutate('delete', 1, { version: 1 }, user);
  await app.store.close();
  app = createApp(config);
  t.after(async () => { await app.store.close(); await rm(folder, { recursive: true, force: true }); });
  assert.equal(app.store.list().length, 1);
  assert.ok(app.store.list()[0].deletedAt);
  assert.equal(app.store.history(1).length, 2);
  assert.deepEqual({ ...app.store.db.prepare('SELECT username, name, job_title AS jobTitle FROM users').get() }, { username: 'restart-user', name: '지속성 확인', jobTitle: '과장' });
});

test('완전 삭제: 삭제된 항목만 허용, 버전·로그인·출처 검증, 실제 DELETE와 백업 보존', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  const { body: { site: untouched } } = await request('/api/sites', 'POST', { ...sample, systemName: '보존할 서버' });
  const path = `/api/sites/${site.id}/permanent`;
  assert.equal((await request(path, 'DELETE', { version: site.version })).status, 409);
  assert.equal((await request(`/api/sites/${site.id}`, 'DELETE', { version: site.version })).status, 200);
  const deleted = store.find(site.id);
  const history = store.history(site.id);
  const beforeBackups = await readdir(backupDir);
  assert.equal((await client()(path, 'DELETE', { version: deleted.version })).status, 401);
  assert.equal((await request(path, 'DELETE', { version: deleted.version }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request(path, 'DELETE', { version: deleted.version }, { 'X-Requested-With': '' })).status, 403);
  for (const body of [{}, { version: site.version }, { version: String(deleted.version) }]) {
    assert.equal((await request(path, 'DELETE', body)).status, 409);
  }
  assert.equal((await request(path)).status, 404);
  assert.equal((await request(path, 'PUT', { version: deleted.version })).status, 404);
  assert.equal((await request(`/api/sites/${site.id}`, 'DELETE', { version: deleted.version })).status, 404);
  assert.deepEqual(store.find(site.id), deleted);
  assert.deepEqual(store.history(site.id), history);
  assert.deepEqual(await readdir(backupDir), beforeBackups);
  const result = await request(path, 'DELETE', { version: deleted.version });
  assert.equal(result.status, 200);
  assert.equal(result.body.changed, true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM sites WHERE id = ?').get(site.id).count, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM history WHERE site_id = ?').get(site.id).count, 0);
  assert.deepEqual((await request('/api/sites')).body.sites, [untouched]);
  assert.equal((await request(`/api/sites/${site.id}/history`)).status, 404);
  assert.equal((await request(path, 'DELETE', { version: deleted.version })).status, 404);
  assert.equal((await request('/api/sites/999999/permanent', 'DELETE', { version: 1 })).status, 404);
  const afterBackups = await readdir(backupDir);
  assert.equal(afterBackups.length, beforeBackups.length + 1);
  assert.ok(beforeBackups.every(file => afterBackups.includes(file)));
  const snapshot = afterBackups.find(file => !beforeBackups.includes(file));
  const backup = new DatabaseSync(join(backupDir, snapshot), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT deleted_at FROM sites WHERE id = ?').get(site.id).deleted_at, deleted.deletedAt);
    assert.equal(backup.prepare('SELECT count(*) AS count FROM history WHERE site_id = ?').get(site.id).count, history.length);
  } finally { backup.close(); }
  assert.equal(store.history(untouched.id).length, 1);
});

test('완전 삭제: 백업 실패 시 서버 정보와 변경 기록 보존', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  await request(`/api/sites/${site.id}`, 'DELETE', { version: site.version });
  const deleted = store.find(site.id);
  const history = store.history(site.id);
  await rename(backupDir, `${backupDir}-original`);
  await writeFile(backupDir, '백업 실패 유도');
  assert.equal((await request(`/api/sites/${site.id}/permanent`, 'DELETE', { version: deleted.version })).status, 503);
  assert.deepEqual(store.find(site.id), deleted);
  assert.deepEqual(store.history(site.id), history);
});

test('완전 삭제: 서버 삭제 실패 시 먼저 지운 변경 기록도 롤백', async t => {
  const { client, store } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  await request(`/api/sites/${site.id}`, 'DELETE', { version: site.version });
  const deleted = store.find(site.id);
  const history = store.history(site.id);
  store.db.exec("CREATE TRIGGER reject_site_delete BEFORE DELETE ON sites BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request(`/api/sites/${site.id}/permanent`, 'DELETE', { version: deleted.version })).status, 500);
  assert.deepEqual(store.find(site.id), deleted);
  assert.deepEqual(store.history(site.id), history);
});

test('완전 삭제: 동시 요청 중 하나만 성공하고 백업도 한 번만 생성', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  await request(`/api/sites/${site.id}`, 'DELETE', { version: site.version });
  const deleted = store.find(site.id);
  const beforeBackups = await readdir(backupDir);
  const results = await Promise.all([
    request(`/api/sites/${site.id}/permanent`, 'DELETE', { version: deleted.version }),
    request(`/api/sites/${site.id}/permanent`, 'DELETE', { version: deleted.version }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 404]);
  assert.equal(store.find(site.id), null);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM history WHERE site_id = ?').get(site.id).count, 0);
  assert.equal((await readdir(backupDir)).length, beforeBackups.length + 1);
});

test('그룹 생성·계층 이동·이름 변경·빈 그룹 삭제, 백업과 버전 충돌', async t => {
  const { client, backupDir } = await setup(t); const request = client();
  assert.equal((await request('/api/groups')).status, 401);
  assert.equal((await request('/api/groups', 'POST', { name: '인프라' })).status, 401);
  await request('/api/register', 'POST', credentials);
  assert.equal((await request('/api/groups', 'POST', { name: '인프라' }, { Origin: 'https://other.example' })).status, 403);
  const { body: { group: parent } } = await request('/api/groups', 'POST', { name: '인프라' });
  const { body: { group: child } } = await request('/api/groups', 'POST', { name: '개발', parentId: parent.id });
  assert.equal(child.parentId, parent.id);
  assert.equal((await request('/api/sites')).body.groups.length, 2);
  const before = await readdir(backupDir);
  assert.equal((await request(`/api/groups/${child.id}`, 'PUT', { ...child })).body.changed, false);
  assert.deepEqual(await readdir(backupDir), before);
  const updated = await request(`/api/groups/${child.id}`, 'PUT', { name: '테스트', parentId: null, version: child.version });
  assert.equal(updated.status, 200); assert.equal(updated.body.group.parentId, null); assert.equal(updated.body.group.version, 2);
  assert.equal((await request(`/api/groups/${child.id}`, 'PUT', { ...child })).status, 409);
  assert.equal((await request(`/api/groups/${child.id}`, 'DELETE', { version: 1 })).status, 409);
  const snapshots = await readdir(backupDir);
  const snapshot = new DatabaseSync(join(backupDir, snapshots.find(file => !before.includes(file))), { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT parent_id FROM groups WHERE id = ?').get(child.id).parent_id, parent.id);
  } finally { snapshot.close(); }
  assert.equal((await request(`/api/groups/${child.id}`, 'DELETE', { version: 2 })).status, 200);
  assert.equal((await request(`/api/groups/${parent.id}`, 'DELETE', { version: 1 })).status, 200);
  assert.deepEqual((await request('/api/groups')).body.groups, []);
  const replacement = await request('/api/groups', 'POST', { name: '다른 그룹' });
  assert.ok(replacement.body.group.id > child.id);
});

test('그룹 이름·상위 그룹·중복·순환 구조 검증과 동시 계층 이동', async t => {
  const { client, store } = await setup(t); const request = client();
  await request('/api/register', 'POST', credentials);
  for (const input of [{}, { name: '' }, { name: ' \t ' }, { name: 123 }, { name: 'a'.repeat(101) }, { name: 'a\nb' }, { name: '개발', parentId: '1' }, { name: '개발', parentId: 0 }, { name: '개발', parentId: 999 }]) {
    assert.equal((await request('/api/groups', 'POST', input)).status, 400);
  }
  const { body: { group: a } } = await request('/api/groups', 'POST', { name: 'Platform' });
  assert.equal((await request('/api/groups', 'POST', { name: ' platform ' })).status, 409);
  const { body: { group: b } } = await request('/api/groups', 'POST', { name: 'Platform', parentId: a.id });
  const { body: { group: c } } = await request('/api/groups', 'POST', { name: '서비스', parentId: b.id });
  for (const parentId of [a.id, b.id, c.id]) assert.equal((await request(`/api/groups/${a.id}`, 'PUT', { ...a, parentId })).status, 400);
  assert.equal((await request(`/api/groups/${b.id}`, 'PUT', { ...b, parentId: null })).status, 409);
  assert.equal((await request(`/api/groups/${a.id}`, 'DELETE', { version: 1 })).status, 409);
  const { body: { group: other } } = await request('/api/groups', 'POST', { name: '외부 그룹' });
  const results = await Promise.all([
    request(`/api/groups/${a.id}`, 'PUT', { ...a, parentId: other.id }),
    request(`/api/groups/${other.id}`, 'PUT', { ...other, parentId: a.id }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(store.listGroups().length, 4);
});

test('서버 그룹 지정·이동·해제와 과거 그룹명 기록, 소속 서버가 있는 그룹 삭제 차단', async t => {
  const { client, store } = await setup(t); const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { group: parent } } = await request('/api/groups', 'POST', { name: '인프라' });
  const { body: { group: child } } = await request('/api/groups', 'POST', { name: '개발', parentId: parent.id });
  for (const groupId of ['1', 0, -1, {}, 1.1, 999]) assert.equal((await request('/api/sites', 'POST', { ...sample, groupId })).status, 400);
  const { body: { site } } = await request('/api/sites', 'POST', { ...sample, groupId: child.id });
  assert.equal(site.groupId, child.id);
  assert.equal((await request(`/api/groups/${child.id}`, 'DELETE', { version: 1 })).status, 409);
  const legacyUpdate = await request(`/api/sites/${site.id}`, 'PUT', { ...sample, notes: '그룹 필드 생략', version: site.version });
  assert.equal(legacyUpdate.body.site.groupId, child.id);
  const moved = await request(`/api/sites/${site.id}`, 'PUT', { ...legacyUpdate.body.site, groupId: parent.id });
  assert.equal(moved.body.site.groupId, parent.id);
  const history = store.history(site.id)[0];
  assert.equal(history.before.groupName, '인프라 / 개발'); assert.equal(history.after.groupName, '인프라');
  await request(`/api/groups/${child.id}`, 'PUT', { ...child, name: '새 이름' });
  assert.equal(store.history(site.id)[0].before.groupName, '인프라 / 개발');
  assert.equal((await request(`/api/groups/${child.id}`, 'DELETE', { version: 2 })).status, 200);
  const cleared = await request(`/api/sites/${site.id}`, 'PUT', { ...moved.body.site, groupId: null });
  assert.equal(cleared.body.site.groupId, null);
  const reassigned = await request(`/api/sites/${site.id}`, 'PUT', { ...cleared.body.site, groupId: parent.id });
  await request(`/api/sites/${site.id}`, 'DELETE', { version: reassigned.body.site.version });
  assert.equal((await request(`/api/groups/${parent.id}`, 'DELETE', { version: 1 })).status, 409);
  assert.equal(store.find(site.id).groupId, parent.id);
});

test('그룹 변경은 백업 실패 시 저장하지 않고 DB 오류 시 롤백', async t => {
  const { client, store, backupDir } = await setup(t); const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { group } } = await request('/api/groups', 'POST', { name: '기존 그룹' });
  store.db.exec("CREATE TRIGGER reject_group_update BEFORE UPDATE ON groups BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request(`/api/groups/${group.id}`, 'PUT', { ...group, name: '실패할 이름' })).status, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(store.listGroups())), [group]);
  await rename(backupDir, `${backupDir}-original`); await writeFile(backupDir, '백업 실패 유도');
  assert.equal((await request('/api/groups', 'POST', { name: '추가 실패' })).status, 503);
  assert.equal((await request(`/api/groups/${group.id}`, 'PUT', { ...group, name: '수정 실패' })).status, 503);
  assert.equal((await request(`/api/groups/${group.id}`, 'DELETE', { version: group.version })).status, 503);
  assert.deepEqual(JSON.parse(JSON.stringify(store.listGroups())), [group]);
});

test('기존 DB의 미분류 서버·이력 보존 및 그룹과 소속 관계의 재시작 후 유지', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-groups-restart-'));
  const config = { dataDir: join(folder, 'data'), backupDir: join(folder, 'backups'), seed: [sample] };
  let app = createApp(config);
  app.store.db.exec("DROP TABLE groups; UPDATE sites SET data = json_remove(data, '$.groupId'); UPDATE history SET after_data = json_remove(after_data, '$.groupId', '$.groupName')");
  const beforeHistory = app.store.history(1);
  await app.store.close();
  app = createApp(config);
  assert.equal(app.store.find(1).groupId, null); assert.equal(app.store.find(1).systemName, sample.systemName);
  assert.deepEqual(app.store.history(1), beforeHistory);
  const { group: parent } = await app.store.mutateGroup('create', null, { name: '상위' });
  const { group: child } = await app.store.mutateGroup('create', null, { name: '하위', parentId: parent.id });
  await app.store.mutate('update', 1, { ...sample, groupId: child.id, version: 1 }, { id: null, name: '검증' });
  await app.store.close();
  app = createApp(config);
  t.after(async () => { await app.store.close(); await rm(folder, { recursive: true, force: true }); });
  assert.equal(app.store.listGroups().length, 2); assert.equal(app.store.find(1).groupId, child.id);
  assert.equal(app.store.history(1)[0].after.groupName, '상위 / 하위');
  assert.equal(app.store.history(1)[0].before.groupName, '미분류');
});


test('기존 기록의 사용자 ID로 현재 직급을 조회하고 원본 데이터·초기 등록을 보존', async t => {
  const { client, store, backupDir } = await setup(t, { seed: [sample] }); const request = client();
  const registered = await request('/api/register', 'POST', { ...credentials, name: '초기 등록' });
  const user = registered.body.user;
  const created = await request('/api/sites', 'POST', { ...sample, actorJobTitle: '위조 직급', updatedByJobTitle: '위조 직급' });
  const id = created.body.site.id;
  assert.equal(created.body.site.updatedByJobTitle, credentials.jobTitle);
  store.db.prepare('UPDATE users SET job_title = ?, name = ? WHERE id = ?').run('부장', '변경된 이름', user.id);
  const originalSites = store.db.prepare('SELECT * FROM sites ORDER BY id').all();
  const originalHistory = store.db.prepare('SELECT * FROM history ORDER BY id').all();
  const originalBackups = await readdir(backupDir);
  const listed = (await request('/api/sites')).body.sites;
  assert.equal(listed.find(site => site.id === id).updatedByJobTitle, '부장');
  assert.equal(listed.find(site => site.id === id).updatedBy, '초기 등록');
  assert.equal(listed.find(site => site.id === 1).updatedByJobTitle, '');
  assert.equal((await request(`/api/sites/${id}/history`)).body.history[0].actorJobTitle, '부장');
  assert.equal((await request('/api/sites/1/history')).body.history[0].actorJobTitle, '');
  assert.deepEqual(store.db.prepare('SELECT * FROM sites ORDER BY id').all(), originalSites);
  assert.deepEqual(store.db.prepare('SELECT * FROM history ORDER BY id').all(), originalHistory);
  assert.deepEqual(await readdir(backupDir), originalBackups);
  store.db.prepare("UPDATE users SET job_title = '' WHERE id = ?").run(user.id);
  assert.equal(store.find(id).updatedByJobTitle, '');
  assert.equal(store.history(id)[0].actorJobTitle, '');
});

test('순서 없이 등록·수정·삭제하고 요청의 순서 값은 DB와 새 이력에 저장하지 않음', async t => {
  const { client, store } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const created = await request('/api/sites', 'POST', sample);
  assert.equal(created.status, 201);
  assert.equal(Object.hasOwn(created.body.site, 'sortOrder'), false);
  const second = await request('/api/sites', 'POST', { ...sample, systemName: '두 번째 서버', sortOrder: 999 });
  assert.equal(second.status, 201);
  const updated = await request(`/api/sites/${created.body.site.id}`, 'PUT', { ...sample, notes: '순서 없는 수정', version: 1 });
  assert.equal(updated.status, 200);
  const ignored = await request(`/api/sites/${second.body.site.id}`, 'PUT', { ...second.body.site, sortOrder: 1 });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.changed, false);
  assert.equal(ignored.body.site.version, 1);
  assert.equal((await request(`/api/sites/${created.body.site.id}`, 'DELETE', { version: updated.body.site.version })).status, 200);
  const sites = (await request('/api/sites')).body.sites;
  assert.deepEqual(sites.map(site => site.id), [created.body.site.id, second.body.site.id]);
  for (const site of sites) {
    assert.equal(Object.hasOwn(site, 'sortOrder'), false);
    assert.equal(Object.hasOwn(JSON.parse(store.db.prepare('SELECT data FROM sites WHERE id = ?').get(site.id).data), 'sortOrder'), false);
    for (const event of store.history(site.id)) {
      assert.equal(Object.hasOwn(event.after, 'sortOrder'), false);
      if (event.before) assert.equal(Object.hasOwn(event.before, 'sortOrder'), false);
    }
  }
});

test('순서가 있는 기존 DB는 재시작 후 등록 순서로 조회하고 원본·과거 이력을 보존', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-numbering-restart-'));
  const config = { dataDir: join(folder, 'data'), backupDir: join(folder, 'backups'), seed: [{ ...sample, sortOrder: 99 }, { ...sample, sortOrder: 1, systemName: '두 번째 서버' }] };
  let app = createApp(config);
  t.after(async () => { await app.store.close(); await rm(folder, { recursive: true, force: true }); });
  for (const { data } of app.store.db.prepare('SELECT data FROM sites').all()) assert.equal(Object.hasOwn(JSON.parse(data), 'sortOrder'), false);
  app.store.db.exec("UPDATE sites SET data = json_set(data, '$.sortOrder', CASE id WHEN 1 THEN 99 ELSE 1 END); UPDATE history SET after_data = json_set(after_data, '$.sortOrder', CASE site_id WHEN 1 THEN 99 ELSE 1 END)");
  const originalSites = app.store.db.prepare('SELECT * FROM sites ORDER BY id').all();
  const originalHistory = app.store.history(1);
  await app.store.close();
  app = createApp(config);
  assert.deepEqual(app.store.list().map(site => site.id), [1, 2]);
  assert.equal(Object.hasOwn(app.store.find(1), 'sortOrder'), false);
  assert.deepEqual(app.store.db.prepare('SELECT * FROM sites ORDER BY id').all(), originalSites);
  assert.deepEqual(app.store.history(1), originalHistory);
  const actor = { id: null, name: '검증' };
  const noChange = await app.store.mutate('update', 1, { ...sample, sortOrder: 2, version: 1 }, actor);
  assert.equal(noChange.changed, false);
  assert.deepEqual(await readdir(config.backupDir), []);
  await app.store.mutate('update', 1, { ...sample, notes: '기존 서버 수정', version: 1 }, actor);
  assert.equal(Object.hasOwn(JSON.parse(app.store.db.prepare('SELECT data FROM sites WHERE id = 1').get().data), 'sortOrder'), false);
  const [event, past] = app.store.history(1);
  assert.equal(Object.hasOwn(event.before, 'sortOrder'), false);
  assert.equal(Object.hasOwn(event.after, 'sortOrder'), false);
  assert.deepEqual(past, originalHistory[0]);
  const snapshot = new DatabaseSync(join(config.backupDir, event.backupFile), { readOnly: true });
  try { assert.equal(JSON.parse(snapshot.prepare('SELECT data FROM sites WHERE id = 1').get().data).sortOrder, 99); }
  finally { snapshot.close(); }
});

test('하위 정보: 네 가지 구분·직접 입력·개별 상속 저장, 무변경과 기존 요청의 하위 정보 보존', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const components = [
    { type: 'WAS', name: 'Tomcat', useSystemIp: true, useSystemSshPort: true, ip: sample.ip, sshPort: sample.sshPort, servicePort: '8080', commonAccount: 'was / test' },
    { type: 'WEB', name: 'Nginx', useSystemIp: true, sshPort: '2222', servicePort: '80,443' },
    { type: 'DB', name: 'PostgreSQL', ip: '192.0.2.30', useSystemSshPort: true, servicePort: '5432', serverAccount: 'db / test' },
    { type: 'OTHER', name: 'Redis', ip: '2001:db8::1', sshPort: '2223', servicePort: '6379', notes: '기타 정보' },
  ];
  const created = await request('/api/sites', 'POST', { ...sample, components });
  assert.equal(created.status, 201);
  const site = created.body.site;
  assert.deepEqual(site.components.map(item => item.type), ['WAS', 'WEB', 'DB', 'OTHER']);
  assert.equal(site.components[0].ip, ''); assert.equal(site.components[0].sshPort, '');
  assert.equal(site.components[1].servicePort, '80, 443'); assert.equal(site.components[1].sshPort, '2222');
  assert.equal(site.components[2].ip, '192.0.2.30'); assert.equal(site.components[2].sshPort, '');
  assert.equal(site.components[3].ip, '2001:db8::1'); assert.equal(site.components[3].sshPort, '2223');
  const before = await readdir(backupDir);
  const unchanged = await request(`/api/sites/${site.id}`, 'PUT', { ...site });
  assert.equal(unchanged.status, 200); assert.equal(unchanged.body.changed, false);
  assert.deepEqual(await readdir(backupDir), before); assert.equal(store.history(site.id).length, 1);
  const updated = await request(`/api/sites/${site.id}`, 'PUT', { ...sample, ip: '192.0.2.99', sshPort: '2200', version: site.version });
  assert.equal(updated.status, 200); assert.deepEqual(updated.body.site.components, site.components);
  assert.equal(updated.body.site.ip, '192.0.2.99'); assert.equal(updated.body.site.sshPort, '2200');
  const history = store.history(site.id)[0];
  assert.equal(history.before.ip, sample.ip); assert.equal(history.after.ip, '192.0.2.99');
  assert.deepEqual(history.after.components, site.components);
  assert.deepEqual((await request('/api/sites')).body.sites[0].components, site.components);
});

test('하위 정보: 입력 검증 실패 시 원본·이력·백업 보존', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  const before = await readdir(backupDir);
  const invalid = [null, {}, 'WAS', [null], [[]], [{ type: 'INVALID', name: '이름' }], [{ type: 'WAS' }], [{ type: 'DB', name: ' ' }], [{ type: 'WEB', name: 123 }], [{ type: 'WAS', name: 'a'.repeat(101) }],
    ...[{ ip: 'invalid' }, { sshPort: '65536' }, { servicePort: '0' }, { url: 'javascript:alert(1)' }, { useSystemIp: 'true' }, { useSystemSshPort: 1 }, { useSystemIp: null }, { externalAccess: 'invalid' }, { notes: {} }].map(input => [{ type: 'WAS', name: '검증', ...input }])];
  for (const components of invalid) {
    const result = await request(`/api/sites/${site.id}`, 'PUT', { ...site, components });
    assert.equal(result.status, 400, JSON.stringify(components));
  }
  assert.deepEqual(store.find(site.id), site); assert.equal(store.history(site.id).length, 1);
  assert.deepEqual(await readdir(backupDir), before);
});

test('하위 정보: 추가·수정·제거·시스템 삭제의 기록과 백업, 동시 수정 차단', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const { body: { site } } = await request('/api/sites', 'POST', sample);
  const path = `/api/sites/${site.id}`;
  const added = await request(path, 'PUT', { ...site, components: [{ type: 'DB', name: '개발 DB', useSystemIp: true, useSystemSshPort: true, commonAccount: 'db / test' }] });
  assert.equal(added.status, 200);
  assert.equal((await request(path, 'PUT', { ...site, components: [] })).status, 409);
  const switched = await request(path, 'PUT', { ...added.body.site, components: [{ ...added.body.site.components[0], useSystemIp: false, ip: '192.0.2.50' }] });
  assert.equal(switched.status, 200); assert.equal(switched.body.site.components[0].ip, '192.0.2.50');
  const removed = await request(path, 'PUT', { ...switched.body.site, components: [] });
  assert.equal(removed.status, 200); assert.deepEqual(removed.body.site.components, []);
  const removalHistory = store.history(site.id)[0];
  assert.deepEqual(removalHistory.before.components, switched.body.site.components); assert.deepEqual(removalHistory.after.components, []);
  const snapshot = new DatabaseSync(join(backupDir, removalHistory.backupFile), { readOnly: true });
  try { assert.deepEqual(JSON.parse(snapshot.prepare('SELECT data FROM sites WHERE id = ?').get(site.id).data).components, switched.body.site.components); }
  finally { snapshot.close(); }
  const restored = await request(path, 'PUT', { ...removed.body.site, components: switched.body.site.components });
  assert.equal((await request(path, 'DELETE', { version: restored.body.site.version })).status, 200);
  assert.deepEqual(store.find(site.id).components, switched.body.site.components);
  assert.deepEqual(store.history(site.id)[0].after.components, switched.body.site.components);
  assert.equal((await request(path, 'PUT', { ...store.find(site.id), components: [] })).status, 404);
});

test('하위 정보: 기존 DB·과거 기록 무변경, 재시작 유지, 백업 실패 시 하위 수정 취소', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devsites-components-'));
  const config = { dataDir: join(folder, 'data'), backupDir: join(folder, 'backups'), seed: [sample] };
  let app = createApp(config);
  t.after(async () => { await app.store.close(); await rm(folder, { recursive: true, force: true }); });
  app.store.db.exec("UPDATE sites SET data = json_remove(data, '$.components'); UPDATE history SET after_data = json_remove(after_data, '$.components')");
  const original = app.store.db.prepare('SELECT * FROM sites').all();
  const history = app.store.history(1);
  await app.store.close(); app = createApp(config);
  assert.deepEqual(app.store.find(1).components, []);
  assert.deepEqual(app.store.db.prepare('SELECT * FROM sites').all(), original);
  assert.deepEqual(app.store.history(1), history);
  const actor = { id: null, name: '검증' };
  assert.equal((await app.store.mutate('update', 1, { ...sample, version: 1 }, actor)).changed, false);
  const saved = await app.store.mutate('update', 1, { ...sample, version: 1, components: [{ type: 'OTHER', name: '기타 서비스', useSystemIp: true, useSystemSshPort: true }] }, actor);
  await app.store.close(); app = createApp(config);
  assert.deepEqual(app.store.find(1), saved.site);
  assert.deepEqual(app.store.history(1).at(-1), history[0]);
  const beforeHistory = app.store.history(1);
  await rename(config.backupDir, `${config.backupDir}-original`); await writeFile(config.backupDir, '백업 실패 유도');
  await assert.rejects(app.store.mutate('update', 1, { ...saved.site, components: [] }, actor), error => error.status === 503);
  assert.deepEqual(app.store.find(1), saved.site); assert.deepEqual(app.store.history(1), beforeHistory);
});

test('Reverse Proxy: WEB 없이 WAS·DB·프록시 구성 저장 및 기존 계정·URL 보존', async t => {
  const { client, store, backupDir } = await setup(t);
  const request = client();
  await request('/api/register', 'POST', credentials);
  const created = await request('/api/sites', 'POST', { ...sample, components: [
    { type: 'WAS', name: 'Tomcat', url: 'https://legacy-was.example.com', useSystemIp: true, useSystemSshPort: true },
    { type: 'DB', name: 'PostgreSQL', url: 'https://legacy-db.example.com', commonAccount: 'db-user / test-password', servicePort: '5432' },
    { type: 'PROXY', name: 'Traefik', servicePort: '80, 443', useSystemIp: true, useSystemSshPort: true, notes: 'WEB 없이 프록시로 연결' },
  ] });
  assert.equal(created.status, 201);
  const site = created.body.site;
  assert.deepEqual(site.components.map(item => item.type), ['WAS', 'DB', 'PROXY']);
  assert.equal(site.components[2].url, '');
  assert.equal(site.components[2].servicePort, '80, 443');
  const backups = await readdir(backupDir);
  assert.equal((await request(`/api/sites/${site.id}`, 'PUT', site)).body.changed, false);
  assert.deepEqual(await readdir(backupDir), backups);
  const updated = await request(`/api/sites/${site.id}`, 'PUT', { ...site, url: 'https://new.example.com' });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.site.components, site.components);
  assert.equal(updated.body.site.components[1].commonAccount, 'db-user / test-password');
  assert.equal(updated.body.site.components[0].url, 'https://legacy-was.example.com');
  assert.equal(updated.body.site.components[1].url, 'https://legacy-db.example.com');
  assert.deepEqual(store.history(site.id)[0].before.components, site.components);
  assert.deepEqual(store.history(site.id)[0].after.components, site.components);
  assert.deepEqual((await request('/api/sites')).body.sites[0].components, site.components);
});
