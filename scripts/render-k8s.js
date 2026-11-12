import { readFile } from 'node:fs/promises';
const [kind, image, job] = process.argv.slice(2);
if (!['app', 'migration-job'].includes(kind) || !/^harbor\.sayinfo\.co\.kr\/devurllist\/devurllist@sha256:[a-f0-9]{64}$/.test(image ?? '') ||
    (kind === 'migration-job' && !/^devurllist-migrate-[a-z0-9-]{1,40}$/.test(job ?? ''))) {
  throw new Error('검증된 이미지 digest와 배포 종류(app 또는 migration-job)를 지정해 주세요.');
}
const source = await readFile(new URL('../k8s/' + kind + '.yaml', import.meta.url), 'utf8');
process.stdout.write(source.replaceAll('__APP_IMAGE__', image).replaceAll('__MIGRATION_JOB__', job ?? ''));
