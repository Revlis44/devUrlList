import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { createPool, columns, quote } from '../lib/mariadb.js';
import { migrateSchema, readSQLiteSnapshot, importSnapshot } from '../lib/mariadb-migration.js';

const config = {
  host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 13316),
  database: process.env.DB_NAME ?? 'devurllist_test',
  user: process.env.DB_USER ?? 'devurllist_test', password: process.env.DB_PASSWORD ?? 'local-test-only',
};
if (!['127.0.0.1', 'localhost'].includes(config.host) || !/^devurllist_[a-z0-9_]*test$/.test(config.database)) {
  throw new Error('통합 테스트는 로컬 devurllist_*test DB에서만 실행할 수 있습니다.');
}
const sample = { systemName: 'MariaDB 검증', notes: '이전 값' };
const credentials = { username: 'member.ONE', name: '전환 검증', jobTitle: '대리', password: 'test-only' };
const listen = async app => {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + app.server.address().port;
};
const request = async (base, path, method = 'GET', body, cookie = '') => {
  const res = await fetch(base + path, { method, headers: { Cookie: cookie,
    'Content-Type': 'application/json', 'X-Requested-With': 'dev-site-list', Origin: base },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

test('MariaDB 실제 DB 전환과 두 앱의 동시 운영', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devurllist-mariadb-'));
  const backupDir = join(folder, 'backups');
  const pool = createPool(config);
  let first, second, legacy;
  const reset = async () => {
    const db = await pool.getConnection();
    try {
      await db.query('SET FOREIGN_KEY_CHECKS=0');
      for (const table of Object.keys(columns).reverse()) await db.query('DROP TABLE IF EXISTS ' + quote(table));
    } finally { await db.query('SET FOREIGN_KEY_CHECKS=1'); db.release(); }
  };
  t.after(async () => {
    await first?.close(); await second?.close(); await legacy?.close();
    await reset(); await pool.end(); await rm(folder, { recursive: true, force: true });
  });
  await reset();
  await migrateSchema(pool);
  await assert.rejects(createApp({ dbClient: 'mariadb', database: config, backupDir }), /이전/);
  legacy = await createApp({ dbClient: 'sqlite', dataDir: join(folder, 'sqlite'), backupDir: join(folder, 'sqlite-backup'), seed: [] });
  const oldBase = await listen(legacy);
  const registered = await request(oldBase, '/api/register', 'POST', credentials);
  const cookie = registered.cookie;
  const actor = registered.body.user;
  const { group: child } = await legacy.store.mutateGroup('create', null, { name: '하위' });
  const { group: parent } = await legacy.store.mutateGroup('create', null, { name: '상위' });
  const { group: removed } = await legacy.store.mutateGroup('create', null, { name: '번호 보존' });
  await legacy.store.mutateGroup('delete', removed.id, { version: removed.version });
  await legacy.store.mutateGroup('update', child.id, { name: child.name, parentId: parent.id, version: 1 });
  const { site } = await legacy.store.mutate('create', null, { ...sample, groupId: child.id }, actor);
  const expectedHistory = legacy.store.history(site.id);
  const expectedUser = legacy.store.db.prepare('SELECT password_hash FROM users').get().password_hash;
  await legacy.close(); legacy = null;
  const snapshot = readSQLiteSnapshot(join(folder, 'sqlite/sites.sqlite'));

  await t.test('스냅샷의 모든 행·관계·해시 보존, 중복 이전 거절', async () => {
    const report = await importSnapshot(pool, snapshot);
    assert.equal(report.users.count, 1); assert.equal(report.groups.count, 2);
    assert.equal((await pool.query('SELECT password_hash FROM users'))[0].password_hash, expectedUser);
    await assert.rejects(importSnapshot(pool, snapshot), /비어 있지/);
    await migrateSchema(pool);
  });
  first = await createApp({ dbClient: 'mariadb', database: config, backupDir });
  second = await createApp({ dbClient: 'mariadb', database: config, backupDir });
  const base1 = await listen(first), base2 = await listen(second);

  await t.test('기존 세션과 비밀번호로 두 앱에서 로그인 유지', async () => {
    assert.deepEqual((await request(base1, '/api/me', 'GET', undefined, cookie)).body.user, actor);
    assert.deepEqual((await request(base2, '/api/me', 'GET', undefined, cookie)).body.user, actor);
    assert.equal((await request(base2, '/api/login', 'POST', { ...credentials, username: 'MEMBER.one' })).status, 200);
    assert.deepEqual(await first.store.history(site.id), expectedHistory);
    assert.equal((await request(base1, '/readyz')).status, 200);
  });

  await t.test('두 앱의 동일 버전 수정 중 하나만 성공, 직전 전체 백업 검증', async () => {
    const results = await Promise.all([
      request(base1, '/api/sites/' + site.id, 'PUT', { ...site, notes: '변경 A' }, cookie),
      request(base2, '/api/sites/' + site.id, 'PUT', { ...site, notes: '변경 B' }, cookie),
    ]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const history = await first.store.history(site.id);
    assert.equal(history.length, 2);
    const backup = JSON.parse(await readFile(join(backupDir, history[0].backupFile), 'utf8'));
    assert.equal(JSON.parse(backup.tables.sites[0].data).notes, '이전 값');
    assert.equal(backup.tables.history.length, 1);
    assert.equal((await readdir(backupDir)).length, 1);
    const current = await first.store.find(site.id);
    assert.equal((await second.store.mutate('update', site.id, current, actor)).changed, false);
    assert.equal((await readdir(backupDir)).length, 1);
  });

  await t.test('그룹 순환·중복 및 소속 시스템이 있는 그룹 삭제 차단', async () => {
    await assert.rejects(first.store.mutateGroup('update', parent.id, { name: parent.name, parentId: child.id, version: 1 }), error => error.status === 400);
    await assert.rejects(second.store.mutateGroup('create', null, { name: '하위', parentId: parent.id }), error => error.status === 409);
    await assert.rejects(second.store.mutateGroup('delete', child.id, { version: 2 }), error => error.status === 409);
    const results = await Promise.all([
      first.store.mutateGroup('create', null, { name: 'Case' }),
      second.store.mutateGroup('create', null, { name: 'CASE' }),
    ].map(promise => promise.then(() => 200, error => error.status)));
    assert.deepEqual(results.sort(), [200, 409]);
    assert.equal((await first.store.listGroups()).find(group => group.name.toLowerCase() === 'case').id, removed.id + 1);
  });

  await t.test('백업 실패 시 데이터·이력 보존', async () => {
    const current = await first.store.find(site.id);
    await rename(backupDir, backupDir + '-original');
    await writeFile(backupDir, 'not-a-directory');
    try {
      await assert.rejects(second.store.mutate('update', site.id, { ...current, notes: '실패해야 함' }, actor), error => error.status === 503);
      assert.deepEqual(await first.store.find(site.id), current);
      assert.equal((await first.store.history(site.id)).length, 2);
    } finally { await rm(backupDir); await rename(backupDir + '-original', backupDir); }
  });

  await t.test('이력 저장 실패 시 데이터 갱신까지 롤백', async () => {
    const current = await first.store.find(site.id);
    await pool.query("CREATE TRIGGER reject_history BEFORE INSERT ON history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test failure'");
    try {
      await assert.rejects(first.store.mutate('update', site.id, { ...current, notes: '롤백' }, actor));
      assert.deepEqual(await second.store.find(site.id), current);
      assert.equal((await second.store.history(site.id)).length, 2);
    } finally { await pool.query('DROP TRIGGER reject_history'); }
  });

  await t.test('소프트 삭제·동시 완전 삭제 및 변경 전 백업 복원', async () => {
    const current = await first.store.find(site.id);
    const { site: deleted } = await second.store.mutate('delete', site.id, { version: current.version }, actor);
    const results = await Promise.all([
      first.store.permanentlyDelete(site.id, { version: deleted.version }),
      second.store.permanentlyDelete(site.id, { version: deleted.version }),
    ].map(promise => promise.then(() => 200, error => error.status)));
    assert.deepEqual(results.sort(), [200, 404]);
    assert.equal(await first.store.find(site.id), null);
    const filename = (await readdir(backupDir)).find(name => name.includes('_permanent-delete_'));
    const backup = JSON.parse(await readFile(join(backupDir, filename), 'utf8'));
    await first.close(); await second.close(); first = null; second = null;
    await reset(); await migrateSchema(pool); await importSnapshot(pool, backup);
    first = await createApp({ dbClient: 'mariadb', database: config, backupDir });
    second = await createApp({ dbClient: 'mariadb', database: config, backupDir });
    assert.ok((await first.store.find(site.id)).deletedAt);
    assert.equal((await first.store.history(site.id)).length, 3);
  });

  await t.test('본인 계정 수정과 시스템 순서·그룹 이동을 두 앱에서 공유', async () => {
    const beforeUser = await second.store.userByUsername(credentials.username);
    const profile = { body: await second.store.updateProfile(actor.id, { name: '계정 수정 검증', jobTitle: '과장' }) };
    assert.equal((await first.store.userByUsername(credentials.username)).name, '계정 수정 검증');
    await assert.rejects(first.store.updateProfile(actor.id, { name: 'a', jobTitle: '' }), error => error.status === 400);
    const profileBackup = JSON.parse(await readFile(join(backupDir, (await readdir(backupDir)).find(name => name.includes('_profile_'))), 'utf8'));
    assert.equal(profileBackup.tables.users.find(user => user.id === actor.id).name, beforeUser.name);
    const a = (await first.store.mutate('create', null, { systemName: '순서 A' }, profile.body.user)).site;
    const b = (await first.store.mutate('create', null, { systemName: '순서 B' }, profile.body.user)).site;
    const move = { groupId: null, version: b.version, targetId: a.id, targetVersion: a.version, placement: 'before' };
    const results = await Promise.all([
      first.store.moveSite(b.id, move, profile.body.user), second.store.moveSite(b.id, move, profile.body.user),
    ].map(promise => promise.then(() => 200, error => error.status)));
    assert.deepEqual(results.sort(), [200, 409]);
    assert.ok((await second.store.find(b.id)).treeOrder < (await second.store.find(a.id)).treeOrder);
    const history = await second.store.history(b.id);
    assert.equal(history[0].action, 'move'); assert.equal(history[0].before.position, 2); assert.equal(history[0].after.position, 1);
    const current = await first.store.find(b.id);
    const moved = await second.store.moveSite(b.id, { groupId: parent.id, version: current.version }, profile.body.user);
    assert.equal(moved.site.groupId, parent.id);
    assert.equal((await first.store.history(b.id))[0].after.groupName, parent.name);
    await rename(backupDir, backupDir + '-held'); await writeFile(backupDir, 'blocked');
    try {
      await assert.rejects(first.store.moveSite(b.id, { groupId: null, version: moved.site.version }, profile.body.user), error => error.status === 503);
      assert.deepEqual(await second.store.find(b.id), moved.site);
      await assert.rejects(first.store.updateProfile(actor.id, { name: '실패 검증', jobTitle: '부장' }), error => error.status === 503);
      assert.equal((await second.store.userByUsername(credentials.username)).name, '계정 수정 검증');
    } finally { await rm(backupDir); await rename(backupDir + '-held', backupDir); }
  });

  await t.test('그룹 순서·상위 이동 공유, 순환·중복·충돌 차단과 순서 저장 롤백', async () => {
    const a = (await first.store.mutateGroup('create', null, { name: '이동 A' })).group;
    const b = (await first.store.mutateGroup('create', null, { name: '이동 B' })).group;
    const child = (await first.store.mutateGroup('create', null, { name: '이동 하위', parentId: a.id })).group;
    const duplicate = (await first.store.mutateGroup('create', null, { name: '이동 A', parentId: b.id })).group;
    const data = { version: b.version, parentId: null, targetId: a.id, targetVersion: a.version, placement: 'before' };
    const results = await Promise.all([first.store.moveGroup(b.id, data), second.store.moveGroup(b.id, data)].map(promise => promise.then(() => 200, error => error.status)));
    assert.deepEqual(results.sort(), [200, 409]);
    const current = await second.store.listGroups();
    const get = id => current.find(group => group.id === id);
    assert.ok(get(b.id).treeOrder < get(a.id).treeOrder);
    await assert.rejects(first.store.moveGroup(a.id, { version: get(a.id).version, parentId: child.id, parentVersion: child.version }), error => error.status === 400);
    await assert.rejects(first.store.moveGroup(a.id, { version: get(a.id).version, parentId: b.id, parentVersion: get(b.id).version }), error => error.status === 409);
    await first.store.mutateGroup('delete', duplicate.id, { version: duplicate.version });
    const before = await second.store.listGroups();
    const orderBefore = (await pool.query("SELECT value FROM metadata WHERE `key`='group-order'"))[0].value;
    await pool.query("CREATE TRIGGER reject_group_order BEFORE UPDATE ON metadata FOR EACH ROW BEGIN IF NEW.`key`='group-order' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'; END IF; END");
    try {
      await assert.rejects(second.store.moveGroup(a.id, { version: get(a.id).version, parentId: b.id, parentVersion: get(b.id).version }));
      assert.deepEqual(await first.store.listGroups(), before);
      assert.equal((await pool.query("SELECT value FROM metadata WHERE `key`='group-order'"))[0].value, orderBefore);
    } finally { await pool.query('DROP TRIGGER reject_group_order'); }
    await rename(backupDir, backupDir + '-held'); await writeFile(backupDir, 'blocked');
    try {
      await assert.rejects(first.store.moveGroup(a.id, { version: get(a.id).version, parentId: b.id, parentVersion: get(b.id).version }), error => error.status === 503);
      assert.deepEqual(await second.store.listGroups(), before);
    } finally { await rm(backupDir); await rename(backupDir + '-held', backupDir); }
    const moved = await second.store.moveGroup(a.id, { version: get(a.id).version, parentId: b.id, parentVersion: get(b.id).version });
    assert.equal(moved.group.parentId, b.id);
    assert.equal((await first.store.listGroups()).find(group => group.id === child.id).parentId, a.id);
    const root = await first.store.moveGroup(a.id, { version: moved.group.version, parentId: null });
    assert.equal(root.group.parentId, null);
    const fresh = await createApp({ dbClient: 'mariadb', database: config, backupDir });
    try { assert.deepEqual(await fresh.store.listGroups(), await first.store.listGroups()); }
    finally { await fresh.close(); }
  });

  await t.test('로그인 제한을 두 앱이 공유하고 종료 준비 시 트래픽 제외', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).store.consumeLoginAttempt('test-address', Date.now())));
    await assert.rejects(first.store.consumeLoginAttempt('test-address', Date.now()), error => error.status === 429);
    const base = await listen(first);
    first.drain();
    assert.equal((await request(base, '/readyz')).status, 503);
    assert.equal((await request(base, '/livez')).status, 200);
  });

  await t.test('이전 중 외래 키 오류가 발생하면 모든 행 삽입을 롤백', async () => {
    await first.close(); await second.close(); first = null; second = null;
    await reset(); await migrateSchema(pool);
    const invalid = structuredClone(snapshot);
    invalid.tables.history[0].actor_id = 999999;
    await assert.rejects(importSnapshot(pool, invalid));
    for (const table of ['users', 'groups', 'sites', 'history', 'sessions']) {
      assert.equal((await pool.query('SELECT COUNT(*) AS count FROM ' + quote(table)))[0].count, 0);
    }
    assert.equal((await pool.query("SELECT value FROM metadata WHERE `key` = 'initialized'")).length, 0);
    await importSnapshot(pool, snapshot);
  });
});
