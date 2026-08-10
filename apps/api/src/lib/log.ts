// Errors reaching a log line often carry text that came from a request body or
// an upstream API response. A newline in that text lets a caller forge log
// records, so everything interpolated here is flattened onto a single line.

const MAX_LENGTH = 4096;

interface DescribedError {
  name: string;
  message: string;
  stack?: string;
}

function describe(error: unknown): DescribedError | string {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Flatten a value onto one log line.
 *
 * JSON encoding turns embedded line breaks into `\n` escapes so a stack trace
 * survives intact. The replaces then cover anything the encoder passed through,
 * such as a lone carriage return in a plain string. They are written as two
 * separate calls over single alternatives because that is the shape CodeQL
 * recognises as a log injection barrier; a character class is not matched.
 */
export function sanitiseForLog(value: unknown): string {
  const described = describe(value);
  const text = typeof described === 'string' ? described : JSON.stringify(described);
  const singleLine = text.replace(/\n|\r/g, ' ').replace(/\u2028|\u2029/g, ' ');
  return singleLine.slice(0, MAX_LENGTH);
}

/**
 * Log an error without letting its contents span lines.
 *
 * `context` is a fixed string written by the caller and is never interpolated
 * from a request.
 */
export function logError(context: string, error: unknown): void {
  console.error(`${context}: ${sanitiseForLog(error)}`);
}
