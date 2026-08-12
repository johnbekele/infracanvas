import {
  createBaselineCache,
  createPreviewCache,
  defaultAssumptions,
  previewPatch,
  registerBuiltInResources,
  type IrPatch,
  type PreviewContext,
  type PreviewResult,
} from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

/**
 * Applies and prices a patch. Never writes.
 *
 * `030-patch-preview-deltas.md` gives this an HTTP shape because it assumed a
 * Python copilot reaching a TypeScript prediction plane. The copilot is
 * TypeScript, so the default implementation calls `previewPatch` in process and
 * saves a loopback round trip per option of a comparison. The interface is kept
 * because `POST /internal/ir/preview` is still served for other languages, and
 * an implementation of this port over it is a dozen lines.
 */
export interface PreviewPlane {
  preview(ir: ArchitectureIr, patch: IrPatch): Promise<PreviewResult>;
}

registerBuiltInResources();

/**
 * Shared across turns on purpose. The keys are content-addressed on the
 * document, the patch, the price snapshot and the assumptions, so an entry
 * cannot go stale, and the baseline is what the options of one comparison have
 * in common.
 */
export function localPreviewPlane(region?: string): PreviewPlane {
  const baselineCache = createBaselineCache();
  const previewCache = createPreviewCache();

  return {
    async preview(ir, patch) {
      const ctx: PreviewContext = {
        // The document states the region it is drawn for; an override exists
        // only so a caller can price the same architecture elsewhere.
        region: region ?? ir.region,
        assumptions: [...defaultAssumptions().values()],
        baselineCache,
        previewCache,
      };
      return previewPatch(ir, patch, ctx);
    },
  };
}
