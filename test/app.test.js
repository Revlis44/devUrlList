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

const sample = { sortOrder: 1, systemName: '검증 서버', url: 'https://example.internal', commonAccount: 'tester / sample-password', ip: '192.168.1.20', servicePort: '8080, 443', sshPort: '22', serverAccount: 'dev', externalAccess: 'no', notes: '최초 값' };
const credentials = { name: '검증 사용자', password: 'OnlyTestPassword123!' };

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
  assert.equal((await second('/api/register', 'POST', { name: '두 번째 사용자', password: 'OtherTestPassword123!' })).status, 201);
  assert.equal((await first('/api/me')).body.user.name, credentials.name);
  const created = await first('/api/sites', 'POST', sample);
  assert.equal(created.status, 201);
  const id = created.body.site.id;
  const updated = await second(`/api/sites/${id}`, 'PUT', { ...sample, notes: '다른 사용자가 수정', version: 1 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.site.version, 2);
  assert.equal((await first(`/api/sites/${id}`, 'PUT', { ...sample, notes: '오래된 화면', version: 1 })).status, 409);
  const noChange = await second(`/api/sites/${id}`, 'PUT', { ...sample, notes: '다른 사용자가 수정', version: 2 });
  assert.equal(noChange.body.changed, false);
  const history = (await first(`/api/sites/${id}/history`)).body.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].actor, '두 번째 사용자');
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
  assert.equal((await first(`/api/sites/${id}`, 'PUT', { ...sample, version: 3 })).status, 404);
  const deletedHistory = (await first(`/api/sites/${id}/history`)).body.history;
  assert.equal(deletedHistory.length, 3);
  assert.equal(deletedHistory[0].action, 'delete');
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
    const account = { name: `길이 ${length} 검증`, password: '1'.repeat(length) };
    assert.equal((await request('/api/register', 'POST', account)).status, 201);
    assert.equal((await request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/login', 'POST', { ...account, password: '2' })).status, 401);
    assert.equal((await request('/api/login', 'POST', account)).status, 200);
    assert.equal((await request('/api/me')).body.user.name, account.name);
  }
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
  for (const patch of [{ url: 'javascript:alert(1)' }, { ip: '999.1.1.1' }, { sshPort: '65536' }, { systemName: '' }, { sortOrder: 0 }, { externalAccess: 'maybe' }, { commonAccount: {} }, { url: 'https://name:password@example.com' }]) {
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
  const user = await app.store.createUser('지속성 확인', 'not-used-for-login');
  await app.store.mutate('delete', 1, { version: 1 }, user);
  await app.store.close();
  app = createApp(config);
  t.after(async () => { await app.store.close(); await rm(folder, { recursive: true, force: true }); });
  assert.equal(app.store.list().length, 1);
  assert.ok(app.store.list()[0].deletedAt);
  assert.equal(app.store.history(1).length, 2);
  assert.equal(app.store.db.prepare('SELECT name FROM users').get().name, '지속성 확인');
});
