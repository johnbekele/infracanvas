// Errors reaching a log line often carry text that came from a request body or
// an upstream API response. A newline in that text lets a caller forge log
// records, so everything interpolated here is flattened onto a single line.

const MAX_LENGTH = 4096;

/** Unwrap an Error into something JSON can encode without losing the stack. */
function describe(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

/**
 * Flatten a value onto one log line.
 *
 * JSON encoding does the work: a line break inside the value becomes a two
 * character `\n` escape, so a stack trace survives in full while the record
 * stays on one line. The replaces then cover the fallback path, where a value
 * JSON cannot encode is stringified directly. Each replaces a single character
 * with the empty string, which is the shape CodeQL recognises as a log
 * injection barrier.
 */
export function sanitiseForLog(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(describe(value)) ?? String(value);
  } catch {
    encoded = String(value);
  }
  return encoded
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\u2028/g, '')
    .replace(/\u2029/g, '')
    .slice(0, MAX_LENGTH);
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
