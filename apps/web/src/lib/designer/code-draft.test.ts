import { describe, expect, it } from 'vitest';

import { drift } from './code-draft';

const generated = ['resource "aws_db_instance" "primary" {', '  multi_az = false', '}'].join('\n');

describe('measuring how far an edited file has drifted from the generated one', () => {
  it('reports no drift before anything is typed', () => {
    expect(drift(generated, null)).toEqual({ added: 0, removed: 0, clean: true });
  });

  it('reports no drift when the draft still matches', () => {
    expect(drift(generated, generated).clean).toBe(true);
  });

  it('counts an altered line as one added and one removed', () => {
    const edited = generated.replace('multi_az = false', 'multi_az = true');

    expect(drift(generated, edited)).toEqual({ added: 1, removed: 1, clean: false });
  });

  it('counts an inserted line as added only', () => {
    const edited = generated.replace('}', '  storage_encrypted = true\n}');

    expect(drift(generated, edited)).toEqual({ added: 1, removed: 0, clean: false });
  });

  it('counts a deleted line as removed only', () => {
    const edited = generated.replace('  multi_az = false\n', '');

    expect(drift(generated, edited)).toEqual({ added: 0, removed: 1, clean: false });
  });

  it('treats blank lines and indentation as formatting rather than change', () => {
    // Otherwise a stray newline reads as a fork from the canvas, and the warning
    // that means "your edits will be lost" stops being believed.
    const edited = `\n${generated.replace('  multi_az', '    multi_az')}\n`;

    expect(drift(generated, edited).clean).toBe(true);
  });
});
