import { describe, it, expect } from 'vitest';
import { isLoopbackAddress } from './loopback.js';

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', 'the usual IPv4 loopback'],
    ['127.0.0.53', 'another address in 127.0.0.0/8'],
    ['127.1.2.3', 'the wider loopback range'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6, what a dual-stack listener reports'],
  ])('accepts %s (%s)', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    ['192.168.1.10', 'a LAN address'],
    ['10.0.0.5', 'a private range address'],
    ['203.0.113.7', 'a public address'],
    ['::ffff:192.168.1.10', 'a mapped LAN address'],
    ['fe80::1', 'a link-local IPv6 address'],
  ])('refuses %s (%s)', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it.each([
    ['127.0.0.1.example.com', 'a hostname that merely begins with the loopback digits'],
    ['1270.0.0.1', 'a near-miss that a prefix check would have accepted'],
    ['127.0.0.1234', 'an octet that is too long'],
    ['0127.0.0.1', 'a leading zero that is not the loopback range'],
  ])('refuses %s (%s)', (address) => {
    // A prefix comparison against "127." accepts every one of these, which is
    // why this is matched as a whole address.
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('refuses an unknown address rather than assuming it is local', () => {
    // req.ip is undefined when Express cannot determine the peer. Treating that
    // as loopback would fail open on exactly the request that deserves scrutiny.
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});
