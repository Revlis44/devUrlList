import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const exec = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shellOptions = { skip: process.platform === 'win32' };

async function install(t) {
  const folder = await mkdtemp(join(tmpdir(), 'devurllist-docker-'));
  const target = join(folder, 'deployment with spaces');
  const env = { ...process.env, APP_UID: String(process.getuid?.() || 1000), APP_GID: String(process.getgid?.() || 1000) };
  t.after(() => rm(folder, { recursive: true, force: true }));
  await exec('bash', [join(projectDir, 'scripts/install-docker.sh'), target], { cwd: folder, env });
  return { folder, target: await realpath(target), env };
}

async function launch(t, target) {
  const app = spawn(process.execPath, ['--import', join(target, 'app/docker/logging.js'), join(target, 'app/server.js')], {
    cwd: target,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: join(target, 'sqlite'), BACKUP_DIR: join(target, 'backup'), LOG_DIR: join(target, 'logs'), APP_ORIGIN: '', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false;
  const completion = once(app, 'close').then(result => { closed = true; return result; });
  const stop = async () => {
    if (!closed) app.kill('SIGTERM');
    const timeout = setTimeout(() => { if (!closed) app.kill('SIGKILL'); }, 5000);
    const [code] = await completion;
    clearTimeout(timeout);
    return code;
  };
  t.after(stop);
  const base = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`서버 시작 시간 초과: ${errors}`)), 10000);
    app.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    app.stderr.on('data', chunk => { errors += chunk; });
    app.once('error', error => { clearTimeout(timeout); reject(error); });
    app.once('close', () => { clearTimeout(timeout); reject(new Error(`서버가 종료되었습니다: ${errors}`)); });
  });
  return { base, stop };
}

test('Docker 설치: 디렉터리 분리, 실제 데이터 제외, 재실행 시 기존 설치 보존', shellOptions, async t => {
  const { target, folder, env } = await install(t);
  assert.deepEqual((await readdir(target)).sort(), ['app', 'backup', 'compose', 'logs', 'sqlite']);
  for (const name of ['sqlite', 'logs', 'backup']) {
    assert.equal((await stat(join(target, name))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(target, name)), []);
  }
  assert.equal((await stat(join(target, 'compose/.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(target, 'app/server.js'), 'utf8'), await readFile(join(projectDir, 'server.js'), 'utf8'));
  assert.deepEqual((await readdir(join(target, 'app'))).sort(), ['docker', 'lib', 'package.json', 'public', 'seed.example.json', 'server.js']);
  const settings = await readFile(join(target, 'compose/.env'), 'utf8');
  assert.match(settings, new RegExp(`APP_UID=${env.APP_UID}`));
  await writeFile(join(target, 'sqlite/keep.sqlite'), '기존 데이터');
  await writeFile(join(target, 'backup/keep.sqlite'), '기존 백업');
  await assert.rejects(exec('bash', [join(projectDir, 'scripts/install-docker.sh'), target], { cwd: folder, env }), error => error.code === 1 && error.stderr.includes('기존 파일을 덮어쓰지 않습니다'));
  assert.equal(await readFile(join(target, 'sqlite/keep.sqlite'), 'utf8'), '기존 데이터');
  assert.equal(await readFile(join(target, 'backup/keep.sqlite'), 'utf8'), '기존 백업');
  assert.equal(await readFile(join(target, 'compose/.env'), 'utf8'), settings);
});

test('Docker 로그: 표준 출력 유지, 한국 시간 날짜별 파일, 제한된 파일 권한', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devurllist-logs-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const result = await exec(process.execPath, ['--import', join(projectDir, 'docker/logging.js'), '-e', 'console.log("실행 로그"); console.error("오류 로그");'], { env: { ...process.env, LOG_DIR: folder } });
  assert.match(result.stdout, /실행 로그/);
  assert.match(result.stderr, /오류 로그/);
  const files = await readdir(folder);
  assert.equal(files.length, 1);
  assert.match(files[0], /^app-\d{4}-\d{2}-\d{2}\.log$/);
  const content = await readFile(join(folder, files[0]), 'utf8');
  assert.match(content, /KST\] \[INFO\] 실행 로그/);
  assert.match(content, /KST\] \[ERROR\] 오류 로그/);
  assert.equal((await stat(join(folder, files[0]))).mode & 0o777, 0o600);
});

test('Docker 배치 경로로 기동: 로그인, DB·백업·로그 생성, 정상 종료와 재시작 후 데이터 유지', shellOptions, async t => {
  const { target } = await install(t);
  let runtime = await launch(t, target);
  assert.equal((await fetch(runtime.base)).status, 200);
  const credentials = { username: 'deployment-test', name: '배치 검증', jobTitle: '대리', password: 'Deployment-Test-Only123!' };
  const requestOptions = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dev-site-list', Origin: runtime.base }, body: JSON.stringify(credentials) };
  const signup = await fetch(`${runtime.base}/api/register`, requestOptions);
  assert.equal(signup.status, 201);
  const crossOrigin = await fetch(`${runtime.base}/api/login`, { ...requestOptions, headers: { ...requestOptions.headers, Origin: 'https://other.example' } });
  assert.equal(crossOrigin.status, 403);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${runtime.base}/api/sites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dev-site-list', Origin: runtime.base, Cookie: cookie },
    body: JSON.stringify({ sortOrder: 3, systemName: '재시작 검증 서버', url: 'https://test.example.com' }),
  });
  assert.equal(created.status, 201);
  assert.ok((await stat(join(target, 'sqlite/sites.sqlite'))).size > 0);
  assert.equal((await readdir(join(target, 'backup'))).filter(name => name.endsWith('.sqlite')).length, 2);
  assert.equal((await readdir(join(target, 'logs'))).filter(name => name.endsWith('.log')).length, 1);
  assert.equal(await runtime.stop(), 0);
  runtime = await launch(t, target);
  requestOptions.headers.Origin = runtime.base;
  assert.equal((await fetch(`${runtime.base}/api/login`, requestOptions)).status, 200);
  const response = await fetch(`${runtime.base}/api/sites`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).sites.some(site => site.systemName === '재시작 검증 서버'));
  assert.equal(await runtime.stop(), 0);
});
