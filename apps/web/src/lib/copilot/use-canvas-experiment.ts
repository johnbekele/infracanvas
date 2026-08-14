import { useCallback, useState } from 'react';

import { apiFetch } from '@/lib/api/client';
import { canvasStoreToIr } from '@/lib/estimate/to-ir';
import { useDesignerStore } from '@/lib/stores/designer-store';

/**
 * The experiment the copilot on the designer canvas talks about.
 *
 * The copilot cannot converse about a drawing. It proposes typed patches
 * against a known document and prices the result, and both of those need
 * something with an identity and a history: a patch that cannot be recorded
 * cannot be undone, and a proposal priced against a canvas that has since been
 * dragged around was priced against nothing.
 *
 * So the canvas gets an experiment the first time it needs one, seeded with
 * whatever is currently drawn. Doing it lazily rather than on page load is what
 * keeps an empty designer from filling the user's history with untouched
 * experiments every time they open the tab.
 */
export interface CanvasExperiment {
  experimentId: string | null;
  /** Nodes the canvas holds that the document cannot represent, so the UI can say so. */
  skipped: string[];
  isStarting: boolean;
  error: string | null;
  /** Idempotent: returns the existing experiment once one has been started. */
  start: () => Promise<string | null>;
}

interface CreatedExperiment {
  experiment: { id: string };
}

export function useCanvasExperiment(designName: string): CanvasExperiment {
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [isStarting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (experimentId !== null) return experimentId;

    const { nodes, edges } = useDesignerStore.getState();
    if (nodes.length === 0) {
      setError('Draw something first: the copilot reasons about an architecture, not a blank page.');
      return null;
    }

    setStarting(true);
    setError(null);
    try {
      const converted = canvasStoreToIr(nodes, edges, { name: designName });
      const created = await apiFetch<CreatedExperiment>('/experiments', {
        method: 'POST',
        body: JSON.stringify({
          name: designName,
          hypothesis: 'Drawn on the canvas, and refined in conversation with the copilot.',
          ir: converted.document,
        }),
      });

      setSkipped(converted.skipped.map((entry) => entry.name));
      setExperimentId(created.experiment.id);
      return created.experiment.id;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start an experiment.');
      return null;
    } finally {
      setStarting(false);
    }
  }, [designName, experimentId]);

  return { experimentId, skipped, isStarting, error, start };
}
