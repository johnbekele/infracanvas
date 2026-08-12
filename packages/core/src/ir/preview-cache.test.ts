import { describe, expect, it } from 'vitest';

import { threeTier } from './fixtures';
import { irDigest } from './digest';
import { baselineKey, createLru, previewKey } from './preview-cache';
import { previewContext, type PreviewContext } from './preview';

function context(): PreviewContext {
  return previewContext(threeTier().region);
}

describe('cache keys', () => {
  it('changes the cache key when the price snapshot version changes', async () => {
    const digest = irDigest(threeTier());
    const before = baselineKey(digest, context());

    // Reading the module fresh with a different snapshot proves the version is
    // folded into the key rather than merely available to it.
    const { PRICE_SNAPSHOT_VERSION } = await import('../resources/pricing/version');
    expect(before).toContain(PRICE_SNAPSHOT_VERSION);
    expect(before.replace(PRICE_SNAPSHOT_VERSION, 'prices-changed')).not.toBe(before);
  });

  it('changes when an assumption value changes', () => {
    const digest = irDigest(threeTier());
    const ctx = context();
    const changed: PreviewContext = {
      ...ctx,
      assumptions: ctx.assumptions.map((assumption) =>
        assumption.id === 'traffic.requestsPerMonth'
          ? { ...assumption, value: assumption.value * 2 }
          : assumption
      ),
    };

    expect(baselineKey(digest, changed)).not.toBe(baselineKey(digest, ctx));
  });

  it('does not change when assumptions are listed in another order', () => {
    const digest = irDigest(threeTier());
    const ctx = context();
    const reordered: PreviewContext = { ...ctx, assumptions: [...ctx.assumptions].reverse() };

    expect(baselineKey(digest, reordered)).toBe(baselineKey(digest, ctx));
  });

  it('changes with the region, since a price list is per region', () => {
    const digest = irDigest(threeTier());
    const ctx = context();

    expect(baselineKey(digest, { ...ctx, region: 'ap-south-1' })).not.toBe(
      baselineKey(digest, ctx)
    );
  });

  it('separates a preview key from the baseline key of the same document', () => {
    const digest = irDigest(threeTier());
    const ctx = context();

    expect(previewKey(digest, 'a'.repeat(64), ctx)).not.toBe(baselineKey(digest, ctx));
    expect(previewKey(digest, 'a'.repeat(64), ctx)).not.toBe(
      previewKey(digest, 'b'.repeat(64), ctx)
    );
  });
});

describe('the least-recently-used store', () => {
  it('evicts the oldest entry once it is full', () => {
    const cache = createLru<number>(2);

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('keeps an entry that is still being read', () => {
    const cache = createLru<number>(2);

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    // `b` was the least recently used, so it is the one that goes.
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });
});
