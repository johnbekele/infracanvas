import { describe, expect, it } from 'vitest';

import { segments } from './render';
import type { CitationView } from './types';

describe('segments', () => {
  it('splits a fenced code block out of assistant prose', () => {
    const result = segments('Before\n```ts\nconst x = 1;\n```\nAfter', []);
    expect(result).toEqual([
      { kind: 'text', text: 'Before\n' },
      { kind: 'block', language: 'ts', text: 'const x = 1;' },
      { kind: 'text', text: '\nAfter' },
    ]);
  });

  it('renders an unverified citation as unverified', () => {
    const citations: CitationView[] = [
      { scheme: 'sku', target: 'ABC', verified: false, reason: 'missing' },
    ];
    const result = segments('Cost uses [sku:ABC].', citations);
    expect(result).toContainEqual({
      kind: 'citation',
      scheme: 'sku',
      target: 'ABC',
      verified: false,
    });
  });

  it('produces no html from assistant text containing a script tag', () => {
    const result = segments('Hello <script>alert(1)</script> world', []);
    expect(result).toEqual([{ kind: 'text', text: 'Hello <script>alert(1)</script> world' }]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/dangerouslySetInnerHTML/);
    expect(result.every((s) => s.kind !== 'block' || !s.text.includes('<div'))).toBe(true);
  });
});
