import { IR_VERSION } from '@infracanvas/ir-schema';

import { PRICE_SNAPSHOT_VERSION } from '../resources/pricing/version';
import { canonicalJson } from './digest';
import { sha256Hex } from './sha256';
import type { PatchBaseline, PreviewContext, PreviewResult } from './preview';
import { PATCH_PREVIEW_VERSION } from './preview-version';

/**
 * Two content-addressed caches, because a comparison asks four questions about
 * one document.
 *
 * The expensive half of a preview is the baseline: cost, availability and every
 * rule evaluated over the whole current architecture, which is identical for
 * every proposal computed against it. Keying on the semantic digest together
 * with the price snapshot, the IR version and the assumption set means a stale
 * entry cannot exist, so there is no invalidation logic to get wrong: an input
 * that changed produces a different key and misses.
 */

export const DEFAULT_BASELINE_ENTRIES = 32;
export const DEFAULT_PREVIEW_ENTRIES = 256;

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  clear(): void;
}

export type BaselineCache = Lru<PatchBaseline>;
export type PreviewCache = Lru<PreviewResult>;

/**
 * Least-recently-used over an insertion-ordered `Map`. A process-local cache is
 * the right size here: entries are cheap to recompute, a shared one would need
 * the invalidation story content addressing makes unnecessary, and a stale read
 * across processes is impossible by construction.
 */
export function createLru<T>(entries: number): Lru<T> {
  const values = new Map<string, T>();
  return {
    get(key) {
      const value = values.get(key);
      if (value === undefined) return undefined;
      values.delete(key);
      values.set(key, value);
      return value;
    },
    set(key, value) {
      values.delete(key);
      values.set(key, value);
      while (values.size > entries) {
        const oldest = values.keys().next();
        if (oldest.done === true) break;
        values.delete(oldest.value);
      }
    },
    get size() {
      return values.size;
    },
    clear() {
      values.clear();
    },
  };
}

export function createBaselineCache(entries = DEFAULT_BASELINE_ENTRIES): BaselineCache {
  return createLru<PatchBaseline>(entries);
}

export function createPreviewCache(entries = DEFAULT_PREVIEW_ENTRIES): PreviewCache {
  return createLru<PreviewResult>(entries);
}

/** Everything other than the document that a figure depended on. */
function contextKey(ctx: PreviewContext): string {
  const assumptions = [...ctx.assumptions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((assumption) => ({ id: assumption.id, value: assumption.value }));

  return [
    `preview:${PATCH_PREVIEW_VERSION}`,
    `ir:${IR_VERSION}`,
    `prices:${PRICE_SNAPSHOT_VERSION}`,
    `region:${ctx.region}`,
    `assumptions:${sha256Hex(canonicalJson(assumptions))}`,
  ].join('|');
}

export function baselineKey(irDigest: string, ctx: PreviewContext): string {
  return `${contextKey(ctx)}|baseline:${irDigest}`;
}

export function previewKey(irDigest: string, patchDigest: string, ctx: PreviewContext): string {
  return `${contextKey(ctx)}|ir:${irDigest}|patch:${patchDigest}`;
}
