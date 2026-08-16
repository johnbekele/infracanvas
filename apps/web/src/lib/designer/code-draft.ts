/**
 * A user's edits to generated infrastructure code, and how far they have drifted
 * from what the canvas would generate now.
 *
 * The canvas is the source of truth and the code is its output, so an edit is a
 * fork: the moment a line is typed, moving a node no longer changes the file the
 * user is reading. Rather than forbid the edit or silently discard it, a draft is
 * kept beside the generated text and the difference between them is shown, so the
 * fork is visible and can be abandoned in one action.
 */

export interface CodeDrift {
  /** Lines present in the draft but not generated, and the reverse. */
  added: number;
  removed: number;
  /** Whether the draft still matches what the canvas generates. */
  clean: boolean;
}

/**
 * A count of differing lines, not a diff.
 *
 * The panel needs one honest number to justify a warning, and a real diff of two
 * multi-hundred-line Terraform files on every keystroke would cost more than the
 * warning is worth. Multiset comparison catches an inserted, deleted or altered
 * line, and is blind only to reordering, which reads as unchanged here.
 */
export function drift(generated: string, draft: string | null): CodeDrift {
  if (draft === null || draft === generated) return { added: 0, removed: 0, clean: true };

  const counts = new Map<string, number>();
  for (const line of significant(generated)) counts.set(line, (counts.get(line) ?? 0) + 1);

  let added = 0;
  for (const line of significant(draft)) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added += 1;
  }

  let removed = 0;
  for (const remaining of counts.values()) removed += remaining;

  return { added, removed, clean: added === 0 && removed === 0 };
}

/** Blank lines are formatting, and counting them as changes overstates the drift. */
function significant(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
