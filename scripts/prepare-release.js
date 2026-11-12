import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const metadata = JSON.parse(await readFile('.release/image-metadata.json', 'utf8'));
const digest = metadata['containerimage.digest'];
if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('빌드 결과 digest가 없습니다.');
const image = 'harbor.sayinfo.co.kr/devurllist/devurllist@' + digest;
await writeFile('.release/image-ref.txt', image + '\n');
for (const kind of ['app', 'migration-job']) {
  const yaml = execFileSync(process.execPath, ['scripts/render-k8s.js', kind, image, process.env.MIGRATION_JOB], { encoding: 'utf8' });
  await writeFile('.release/' + kind + '.yaml', yaml);
}
