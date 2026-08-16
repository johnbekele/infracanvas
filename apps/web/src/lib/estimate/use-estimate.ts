import { useMemo } from 'react';
import type { ArchitectureIr } from '@infracanvas/core';

import { useAssumptionStore } from '@/lib/stores/assumption-store';
import { useDesignerStore } from '@/lib/stores/designer-store';

import { assumptionsFrom, estimateArchitecture, type ArchitectureEstimate } from './estimate';
import { canvasStoreToIr } from './to-ir';

export interface EstimateResult {
  estimate: ArchitectureEstimate | null;
  /** The document every figure was computed from, for anything that re-solves it. */
  document: ArchitectureIr;
  /** The assumptions in force, so a re-solve uses the same inputs as the headline. */
  assumptions: ReturnType<typeof assumptionsFrom>;
  /** Nodes on the canvas the model could not read, with the reason. */
  skipped: { id: string; name: string; reason: string }[];
  /** Set when the canvas cannot be converted at all, which is a bug worth showing. */
  error: string | null;
  overrideAssumption: (id: string, value: number) => void;
  resetAssumptions: () => void;
}

/**
 * Recomputes on every canvas change and every assumption edit.
 *
 * No debounce and no memo cache keyed by anything clever: pricing forty
 * resources is well under a millisecond, so the honest implementation is to
 * recompute and let the memo on the node list do the work. If that stops being
 * true the fix is the incremental path already in `reviseAssumption`, not a
 * spinner.
 */
export function useEstimate(): EstimateResult {
  const nodes = useDesignerStore((state) => state.nodes);
  const edges = useDesignerStore((state) => state.edges);
  const designName = useDesignerStore((state) => state.designName);

  const overrides = useAssumptionStore((state) => state.overrides);
  const overrideAssumption = useAssumptionStore((state) => state.override);
  const resetAssumptions = useAssumptionStore((state) => state.reset);

  return useMemo(() => {
    const { document, skipped } = canvasStoreToIr(nodes, edges, { name: designName });
    const shared = { document, skipped, overrideAssumption, resetAssumptions };

    try {
      return {
        ...shared,
        estimate: estimateArchitecture(document, overrides),
        assumptions: assumptionsFrom(overrides),
        error: null,
      };
    } catch (cause) {
      // An estimate that throws must not take the canvas down with it; the
      // panel says it could not compute and the drawing carries on working.
      return {
        ...shared,
        estimate: null,
        assumptions: assumptionsFrom(),
        error: cause instanceof Error ? cause.message : 'The estimate could not be computed.',
      };
    }
  }, [nodes, edges, designName, overrides, overrideAssumption, resetAssumptions]);
}
