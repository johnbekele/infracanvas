import type { CitationView } from './types';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'block'; language: string | null; text: string }
  | { kind: 'citation'; scheme: 'file' | 'sku' | 'prediction'; target: string; verified: boolean };

const CITATION_RE = /^\[(file|sku|prediction):([^\]]{1,200})\]/;
const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)(?:\n```|$)/;
const INLINE_CODE_RE = /^`([^`\n]+)`/;

/**
 * Splits assistant text into segments. Never produces HTML — markers become
 * typed segments, and raw tags stay as text so React escapes them.
 */
export function segments(text: string, citations: CitationView[]): Segment[] {
  const verified = new Map(citations.map((c) => [`${c.scheme}:${c.target}`, c.verified] as const));

  const out: Segment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.startsWith('```')) {
      const fence = FENCE_RE.exec(remaining);
      if (fence) {
        const language = fence[1].trim() || null;
        out.push({ kind: 'block', language, text: fence[2] });
        remaining = remaining.slice(fence[0].length);
        continue;
      }
      pushText(out, '```');
      remaining = remaining.slice(3);
      continue;
    }

    if (remaining.startsWith('`')) {
      const inline = INLINE_CODE_RE.exec(remaining);
      if (inline) {
        out.push({ kind: 'code', text: inline[1] });
        remaining = remaining.slice(inline[0].length);
        continue;
      }
    }

    const cite = CITATION_RE.exec(remaining);
    if (cite) {
      const scheme = cite[1] as 'file' | 'sku' | 'prediction';
      const target = cite[2];
      out.push({
        kind: 'citation',
        scheme,
        target,
        verified: verified.get(`${scheme}:${target}`) ?? false,
      });
      remaining = remaining.slice(cite[0].length);
      continue;
    }

    const nextSpecial = findNextSpecial(remaining.slice(1));
    const end = nextSpecial === -1 ? remaining.length : nextSpecial + 1;
    pushText(out, remaining.slice(0, end));
    remaining = remaining.slice(end);
  }

  return mergeText(out);
}

function findNextSpecial(text: string): number {
  const fence = text.indexOf('```');
  const tick = text.indexOf('`');
  const bracket = text.indexOf('[');
  const candidates = [fence, tick, bracket].filter((i) => i >= 0);
  if (candidates.length === 0) return -1;
  return Math.min(...candidates);
}

function pushText(out: Segment[], text: string): void {
  if (text.length === 0) return;
  out.push({ kind: 'text', text });
}

function mergeText(segmentsList: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const seg of segmentsList) {
    const last = merged[merged.length - 1];
    if (seg.kind === 'text' && last?.kind === 'text') {
      last.text += seg.text;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}
