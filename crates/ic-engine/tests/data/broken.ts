/**
 * Deliberate syntax-error fixture for the chunker ERROR-path test.
 *
 * The joined string is the file body under test. It cannot live as raw `.ts`
 * source because Gate 2 prettier/eslint must parse every `*.ts` file.
 */
export const BROKEN_TYPESCRIPT_SOURCE = [
  'export function beforeError(): number {',
  '  return 1;',
  '}',
  '',
  'export function broken({{{',
  '',
  'export function afterError(): number {',
  '  return 2;',
  '}',
].join('\n');
