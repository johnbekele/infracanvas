import { create } from 'zustand';

/**
 * Assumption overrides, shared by everything that shows a figure.
 *
 * They were component state on the estimate hook, which was fine while one
 * panel existed. With a dock and a full dashboard reading the same
 * architecture, per-component state means a user can change the traffic on one
 * and watch the other keep quoting the old number -- two answers about one
 * design, which is exactly what this tool exists to avoid.
 *
 * Deliberately not persisted. An override is an argument about a specific
 * question, and one restored silently three days later is a figure nobody can
 * account for.
 */
interface AssumptionState {
  overrides: ReadonlyMap<string, number>;
  override: (id: string, value: number) => void;
  reset: () => void;
}

export const useAssumptionStore = create<AssumptionState>((set) => ({
  overrides: new Map(),
  override: (id, value) => set((state) => ({ overrides: new Map(state.overrides).set(id, value) })),
  reset: () => set({ overrides: new Map() }),
}));
