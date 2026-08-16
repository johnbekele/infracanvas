import { describe, expect, it } from 'vitest';

import { sha256Hex } from './sha256';

/**
 * The published FIPS 180-4 vectors, plus the block-boundary cases where a
 * hand-written padding step goes wrong: exactly 55, 56, 63 and 64 bytes, which
 * are the lengths either side of the point where the length field no longer
 * fits in the final block.
 */
describe('sha256Hex', () => {
  it('matches the published vector for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the published vector for abc', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('matches the published vector for a two-block message', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });

  it('pads correctly either side of the block boundary', () => {
    const expected: Record<number, string> = {
      55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
      56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
      63: '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34',
      64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    };
    for (const [length, digest] of Object.entries(expected)) {
      expect(sha256Hex('a'.repeat(Number(length))), `${length} bytes`).toBe(digest);
    }
  });

  it('hashes the bytes of a string rather than its code units', () => {
    // A digest that differed by platform would make an open proposal look stale
    // to one process and current to another.
    expect(sha256Hex('café')).toBe(
      sha256Hex(new TextDecoder().decode(new TextEncoder().encode('café')))
    );
    expect(sha256Hex('café')).not.toBe(sha256Hex('cafe'));
  });
});
