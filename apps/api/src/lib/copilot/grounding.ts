import type { CitationScheme, CopilotEvent } from './events.js';

/**
 * Grounding is enforced by a ledger, not by asking the model to be careful.
 *
 * Every factual claim in a turn has to cite a repository file, a price line or
 * a computed prediction. The profile agent can collect a whole answer, discard
 * findings whose citations no tool returned, and serialise what is left; a
 * streaming turn cannot, because a token that has been sent cannot be
 * withdrawn.
 *
 * So the tool layer records what it actually returned this turn, the prompt
 * requires an inline marker, and the stream is filtered as it passes: text
 * flows through untouched and a marker is checked against the ledger and turned
 * into a `citation` event that says whether it stands. The user sees an
 * unsupported citation rendered as unsupported rather than as a link, and the
 * turn records how many there were.
 */

export const CITATION_PATTERN = /\[(file|sku|prediction):([^\]\s]{1,200})\]/;

/** A marker longer than this is not a marker. It bounds what the filter holds. */
export const MAX_MARKER_CHARS = 220;

interface Span {
  path: string;
  start: number;
  end: number;
}

/**
 * What the tools returned. Append-only, written by the tool layer, and not
 * reachable from a tool argument or a model response - which is the only reason
 * a check against it means anything.
 */
export class GroundingLedger {
  private readonly spans: Span[] = [];
  private readonly skus = new Set<string>();
  private readonly predictions = new Set<string>();

  recordSpan(path: string, startLine: number, endLine: number): void {
    this.spans.push({ path, start: startLine, end: endLine });
  }

  /** A whole file a tool returned as evidence, with no line range to narrow it. */
  recordFile(path: string): void {
    this.spans.push({ path, start: 1, end: Number.MAX_SAFE_INTEGER });
  }

  recordSku(sku: string): void {
    this.skus.add(sku);
  }

  recordPrediction(patchDigest: string): void {
    this.predictions.add(patchDigest);
  }

  /**
   * Whether a marker stands, and why not when it does not.
   *
   * A file marker verifies when the path matches and the cited range lies
   * inside a range a tool returned. A wider range is unverified: a claim about
   * lines nobody read is a claim.
   */
  check(scheme: CitationScheme, target: string): { verified: boolean; reason: string | null } {
    if (scheme === 'sku') {
      return this.skus.has(target)
        ? { verified: true, reason: null }
        : { verified: false, reason: 'No price line with this identifier was returned this turn.' };
    }

    if (scheme === 'prediction') {
      return this.predictions.has(target)
        ? { verified: true, reason: null }
        : {
            verified: false,
            reason: 'No prediction with this patch digest was computed this turn.',
          };
    }

    const cited = parseFileTarget(target);
    if (cited === null) {
      return {
        verified: false,
        reason: 'A file citation needs a path, optionally with #Lstart-Lend.',
      };
    }

    const read = this.spans.filter((span) => span.path === cited.path);
    if (read.length === 0) {
      return { verified: false, reason: 'No tool returned this file this turn.' };
    }
    const covered = read.some((span) => cited.start >= span.start && cited.end <= span.end);
    return covered
      ? { verified: true, reason: null }
      : { verified: false, reason: 'The cited lines are outside the range any tool returned.' };
  }
}

function parseFileTarget(target: string): Span | null {
  const [path, fragment] = target.split('#');
  if (path === undefined || path === '') return null;
  if (fragment === undefined) return { path, start: 1, end: Number.MAX_SAFE_INTEGER };

  const range = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
  if (range === null) return null;

  const start = Number.parseInt(range[1], 10);
  const end = range[2] === undefined ? start : Number.parseInt(range[2], 10);
  return { path, start, end };
}

export interface GroundedEvent {
  kind: 'text' | 'citation';
  text?: string;
  scheme?: CitationScheme;
  target?: string;
  verified?: boolean;
  reason?: string | null;
}

/**
 * Passes text through and checks markers as they close.
 *
 * Only the characters between an unmatched `[` and its `]` are held, so latency
 * is bounded by the marker length rather than by the length of the reply. A run
 * of `MAX_MARKER_CHARS` with no `]` is flushed as ordinary text, so a code
 * sample containing a bracket cannot stall a turn.
 */
export class GroundedStream {
  private held = '';

  constructor(private readonly ledger: GroundingLedger) {}

  /** Feed one chunk of model output; get back the text and citations it resolved to. */
  push(chunk: string): GroundedEvent[] {
    const out: GroundedEvent[] = [];
    let text = '';

    for (const char of chunk) {
      if (this.held === '') {
        if (char === '[') {
          if (text !== '') {
            out.push({ kind: 'text', text });
            text = '';
          }
          this.held = '[';
        } else {
          text += char;
        }
        continue;
      }

      this.held += char;

      if (char === ']') {
        const marker = CITATION_PATTERN.exec(this.held);
        if (marker === null) {
          // A bracketed run that is not a marker is what the model wrote, and
          // is passed through exactly as written.
          text += this.held;
        } else {
          const scheme = marker[1] as CitationScheme;
          const target = marker[2];
          const { verified, reason } = this.ledger.check(scheme, target);
          if (text !== '') {
            out.push({ kind: 'text', text });
            text = '';
          }
          out.push({ kind: 'citation', scheme, target, verified, reason });
        }
        this.held = '';
        continue;
      }

      if (this.held.length >= MAX_MARKER_CHARS) {
        text += this.held;
        this.held = '';
      }
    }

    if (text !== '') out.push({ kind: 'text', text });
    return out;
  }

  /** Whatever is still held when the model stops, which is ordinary text by definition. */
  flush(): GroundedEvent[] {
    if (this.held === '') return [];
    const text = this.held;
    this.held = '';
    return [{ kind: 'text', text }];
  }
}

/** The event a grounded chunk becomes, once a sequence number is attached. */
export function eventFor(entry: GroundedEvent, seq: number): CopilotEvent {
  if (entry.kind === 'text') return { kind: 'token', seq, text: entry.text ?? '' };
  return {
    kind: 'citation',
    seq,
    scheme: entry.scheme as CitationScheme,
    target: entry.target ?? '',
    verified: entry.verified === true,
    reason: entry.reason ?? null,
  };
}
