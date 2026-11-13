import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
for (const scenario of ['first-deploy', 'deployment-success', 'schema-failure', 'rollout-failure', 'smoke-failure', 'public-smoke-failure']) {
  test('배포 처리: ' + scenario, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'devurllist-deploy-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    await mkdir(join(folder, 'scripts'));
    await mkdir(join(folder, '.release'));
    await copyFile(new URL('../scripts/prepare-rollback.js', import.meta.url), join(folder, 'scripts/prepare-rollback.js'));
    await writeFile(join(folder, 'package.json'), '{"type":"module"}');
    await writeFile(join(folder, 'scripts/smoke.js'), `
import { appendFileSync } from 'node:fs';
const url = process.argv[2];
appendFileSync(process.env.CALLS, 'smoke ' + url + '\\n');
process.exit(process.env.SCENARIO === 'smoke-failure' ||
  (process.env.SCENARIO === 'public-smoke-failure' && url.startsWith('https://')) ? 1 : 0);
`);
    await writeFile(join(folder, '.release/app.yaml'), 'prepared');
    await writeFile(join(folder, '.release/migration-job.yaml'), 'prepared');
    await writeFile(join(folder, 'kubectl'), `#!/bin/sh
echo "$*" >> "$CALLS"
case "$*" in
  *"get deployment/devurllist"*)
    if [ "$SCENARIO" = first-deploy ]; then exit 0; fi
    echo '{"apiVersion":"v1","kind":"List","items":[{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"devurllist","namespace":"devurllist","resourceVersion":"1"},"spec":{"replicas":2}}]}'
    ;;
  *"wait --for=condition=complete"*) [ "$SCENARIO" != schema-failure ];;
  *"rollout status"*)
    if [ "$SCENARIO" = rollout-failure ] && [ ! -f "$ROLLBACK" ]; then exit 1; fi
    ;;
  *"apply -f .release/rollback.json"*) touch "$ROLLBACK";;
esac
`, { mode: 0o755 });
    const result = exec('sh', [new URL('../scripts/deploy-k8s.sh', import.meta.url).pathname], {
      cwd: folder, env: { ...process.env, PATH: folder + ':' + dirname(process.execPath) + ':' + process.env.PATH,
        SCENARIO: scenario, CALLS: join(folder, 'calls'), ROLLBACK: join(folder, 'rolled-back'), MIGRATION_JOB: 'devurllist-migrate-test' },
    });
    if (scenario === 'first-deploy' || scenario === 'deployment-success') await result;
    else await assert.rejects(result);
    const calls = await readFile(join(folder, 'calls'), 'utf8');
    if (scenario === 'first-deploy') {
      assert.match(calls, /create -f .release\/migration-job.yaml/);
      assert.match(calls, /apply -f .release\/app.yaml/);
      assert.doesNotMatch(calls, /apply -f .release\/rollback.json/);
      await assert.rejects(readFile(join(folder, '.release/rollback.json')), { code: 'ENOENT' });
    } else if (scenario === 'deployment-success') {
      assert.match(calls, /apply -f .release\/app.yaml/);
      assert.doesNotMatch(calls, /apply -f .release\/rollback.json/);
    } else if (scenario === 'schema-failure') {
      assert.doesNotMatch(calls, /apply -f/);
    } else {
      assert.match(calls, /apply -f .release\/app.yaml/);
      assert.match(calls, /apply -f .release\/rollback.json/);
      const rollback = JSON.parse(await readFile(join(folder, '.release/rollback.json'), 'utf8'));
      assert.equal(rollback.items[0].metadata.resourceVersion, undefined);
    }
    if (['first-deploy', 'deployment-success', 'public-smoke-failure'].includes(scenario)) {
      assert.match(calls, /smoke http:\/\/devurllist\.devurllist\.svc\.cluster\.local:3000\nsmoke https:\/\/devurl\.intra\.sayinfo\.co\.kr\n/);
    } else {
      assert.doesNotMatch(calls, /smoke https:/);
    }
    assert.doesNotMatch(calls, /bootstrap|httproute|referencegrant|delete/);
  });
}

test('배포 템플릿은 정확한 저장소 digest만 허용', async () => {
  const render = new URL('../scripts/render-k8s.js', import.meta.url).pathname;
  await assert.rejects(exec(process.execPath, [render, 'app', 'harbor.sayinfo.co.kr/devurllist/devurllist:latest']));
  await assert.rejects(exec(process.execPath, [render, 'app', 'harborXsayinfoXcoXkr/devurllist/devurllist@sha256:' + 'a'.repeat(64)]));
  const image = 'harbor.sayinfo.co.kr/devurllist/devurllist@sha256:' + 'a'.repeat(64);
  const { stdout } = await exec(process.execPath, [render, 'app', image]);
  assert.ok(stdout.includes(image)); assert.ok(!stdout.includes('__APP_IMAGE__'));
});
