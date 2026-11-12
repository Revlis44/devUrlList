import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientAddress } from '../lib/client-address.js';

test('프록시 신뢰 범위 밖의 전달 헤더를 무시하고 신뢰한 경로만 역순으로 확인', () => {
  const req = (remote, header) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': header } });
  assert.equal(createClientAddress()(req('10.42.1.2', '192.0.2.1')), '10.42.1.2');
  const resolve = createClientAddress('10.42.0.0/16');
  assert.equal(resolve(req('192.0.2.2', '192.0.2.1')), '192.0.2.2');
  assert.equal(resolve(req('::ffff:10.42.1.2', '198.51.100.9, 192.0.2.1, 10.42.2.3')), '192.0.2.1');
  assert.equal(resolve(req('10.42.1.2', 'invalid, 192.0.2.1')), '10.42.1.2');
  assert.throws(() => createClientAddress('10.42.1.2'), /CIDR/);
});
