import type { ToolCall } from './models.js';
import type { PreviewPlane } from './preview-plane.js';
import type { CopilotScope, CopilotStore } from './store.js';

/**
 * Everything a tool is allowed to reach.
 *
 * The scope is here rather than in any argument model, which is the whole
 * security property of the surface: a model can write anything it likes into a
 * tool call and still only ever address the experiment the turn was opened for.
 */
export interface CopilotDeps {
  scope: CopilotScope;
  store: CopilotStore;
  /** Applies and prices a patch. Never writes. */
  preview: PreviewPlane;
  /**
   * Every call the layer served this turn, appended by the layer itself. The
   * run loop streams from this; the model cannot write to it.
   */
  calls: ToolCall[];
}

export function copilotDeps(
  scope: CopilotScope,
  store: CopilotStore,
  preview: PreviewPlane
): CopilotDeps {
  return { scope, store, preview, calls: [] };
}
