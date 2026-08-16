import { useCallback, useMemo, useState } from 'react';
import { useDesignerStore } from '@/lib/stores/designer-store';

import { estimateArchitecture, type ArchitectureEstimate } from './estimate';
import { canvasStoreToIr } from './to-ir';

export interface EstimateResult {
  estimate: ArchitectureEstimate | null;
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
  const [overrides, setOverrides] = useState<ReadonlyMap<string, number>>(new Map());

  const overrideAssumption = useCallback((id: string, value: number) => {
    setOverrides((current) => new Map(current).set(id, value));
  }, []);

  const resetAssumptions = useCallback(() => setOverrides(new Map()), []);

  return useMemo(() => {
    const { document, skipped } = canvasStoreToIr(nodes, edges, { name: designName });
    try {
      return {
        estimate: estimateArchitecture(document, overrides),
        skipped,
        error: null,
        overrideAssumption,
        resetAssumptions,
      };
    } catch (cause) {
      // An estimate that throws must not take the canvas down with it; the
      // panel says it could not compute and the drawing carries on working.
      return {
        estimate: null,
        skipped,
        error: cause instanceof Error ? cause.message : 'The estimate could not be computed.',
        overrideAssumption,
        resetAssumptions,
      };
    }
  }, [nodes, edges, designName, overrides, overrideAssumption, resetAssumptions]);
}
