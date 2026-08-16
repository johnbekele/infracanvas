/**
 * Every modelled number this engine produces is a guess about traffic nobody
 * has measured yet. The envelope below is what stops a guess being read as a
 * measurement: the label is a literal rather than a boolean, so no renderer can
 * print a figure without also saying it was predicted, and the assumptions that
 * produced it travel with it rather than being looked up later from a global.
 */

export interface Assumption {
  /** Dotted and stable, for example `traffic.requestsPerMonth`. Referenced by cost lines. */
  id: string;
  label: string;
  value: number;
  unit: string;
  /** `profile` means derived from the repository analysis; `user` means overridden on the canvas. */
  source: 'default' | 'profile' | 'user';
  rationale: string;
}

export interface Prediction<T> {
  label: 'Predicted';
  value: T;
  /** Sorted by id, so two predictions of the same thing compare equal. */
  assumptions: Assumption[];
  /** Inputs that were missing, in plain language. */
  gaps: string[];
}

/**
 * The only constructor. Assumptions are deduplicated by id and sorted, because
 * the same assumption reaching a roll-up through two resources is one
 * assumption, and a user editing it expects one input rather than two.
 */
export function predicted<T>(
  value: T,
  assumptions: Assumption[],
  gaps: string[] = []
): Prediction<T> {
  const byId = new Map<string, Assumption>();
  for (const assumption of assumptions) byId.set(assumption.id, assumption);
  return {
    label: 'Predicted',
    value,
    assumptions: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    gaps: [...new Set(gaps)].sort(),
  };
}
