import { BlockList, isIP } from 'node:net';

const normalize = address => address?.startsWith('::ffff:') ? address.slice(7) : address;

export function createClientAddress(cidrs = '') {
  const trusted = new BlockList();
  for (const cidr of cidrs.split(',').map(value => value.trim()).filter(Boolean)) {
    const [address, prefix, extra] = cidr.split('/');
    const version = isIP(address);
    if (!version || extra || !/^\d+$/.test(prefix ?? '')) throw new Error('TRUST_PROXY_CIDRS에 올바른 CIDR을 입력해 주세요.');
    trusted.addSubnet(address, Number(prefix), version === 4 ? 'ipv4' : 'ipv6');
  }
  return req => {
    const remote = normalize(req.socket.remoteAddress);
    const header = req.headers['x-forwarded-for'];
    if (typeof header !== 'string') return remote;
    const chain = header.split(',').map(value => normalize(value.trim()));
    if (chain.some(address => !isIP(address))) return remote;
    let current = remote;
    while (chain.length && isIP(current) && trusted.check(current, isIP(current) === 4 ? 'ipv4' : 'ipv6')) current = chain.pop();
    return current;
  };
}
