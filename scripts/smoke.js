const [base] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) throw new Error('검증할 서비스 주소가 필요합니다.');
for (const [path, expected] of [['/readyz', 200], ['/livez', 200], ['/', 200], ['/api/me', 200], ['/api/sites', 401]]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (response.status !== expected) throw new Error(path + ' 상태가 예상과 다릅니다: ' + response.status);
  await response.arrayBuffer();
}
console.log('서비스 상태와 인증 경계 확인 완료');
