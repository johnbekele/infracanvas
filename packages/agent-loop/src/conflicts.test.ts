import { describe, expect, it } from 'vitest';

import { declaredPaths, overlaps, parseFilesSection, pathsCollide } from './conflicts';

const SPEC = `### Context

Some prose.

### Files

- CREATE \`packages/agent-loop/src/queue.ts\` — eligibility
- MODIFY \`package.json\` - add the loop script
- DELETE \`docs/old.md\` — superseded
- a bullet with no backticked path is ignored
- MODIFY not a bullet with a path

### Acceptance Criteria

- [ ] something
`;

describe('parseFilesSection', () => {
  it('reads the operation and the backticked path from each bullet', () => {
    expect(parseFilesSection(SPEC)).toEqual([
      { op: 'CREATE', path: 'packages/agent-loop/src/queue.ts' },
      { op: 'MODIFY', path: 'package.json' },
      { op: 'DELETE', path: 'docs/old.md' },
    ]);
  });

  it('stops at the next heading and ignores bullets without a backticked path', () => {
    expect(declaredPaths(SPEC)).not.toContain('something');
    expect(declaredPaths(SPEC)).toHaveLength(3);
  });

  it('returns nothing when there is no Files section', () => {
    expect(parseFilesSection('### Context\n\nno files here')).toEqual([]);
  });
});

describe('pathsCollide', () => {
  it('treats an equal path as a collision', () => {
    expect(pathsCollide('apps/api/src/x.ts', 'apps/api/src/x.ts')).toBe(true);
  });

  it('treats a directory as colliding with anything beneath it', () => {
    expect(pathsCollide('apps/api', 'apps/api/src/index.ts')).toBe(true);
    expect(pathsCollide('apps/api/src/index.ts', 'apps/api')).toBe(true);
  });

  it('does not collide on a shared string prefix that is not a path segment', () => {
    expect(pathsCollide('apps/api', 'apps/api-client/index.ts')).toBe(false);
  });

  it('does not collide on unrelated paths', () => {
    expect(pathsCollide('apps/web/x.ts', 'packages/core/y.ts')).toBe(false);
  });
});

describe('overlaps', () => {
  it('is true when any candidate path collides with any running path', () => {
    expect(overlaps(['apps/web/x.ts', 'packages/core/y.ts'], ['packages/core'])).toBe(true);
  });

  it('is false when no candidate path collides', () => {
    expect(overlaps(['apps/web/x.ts'], ['packages/core', 'db/'])).toBe(false);
  });

  it('is false against an empty running set', () => {
    expect(overlaps(['apps/web/x.ts'], [])).toBe(false);
  });
});
