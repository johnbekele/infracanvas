import { describe, expect, it } from 'vitest';

import { hasAiTrailer, hasSecret, isSharedFile, scopeRespected } from './facts';

describe('scopeRespected', () => {
  it('accepts files the issue declared', () => {
    expect(scopeRespected(['db/migrations/x.sql'], ['db/'])).toBe(true);
  });

  it('rejects a file outside the declared paths', () => {
    expect(scopeRespected(['apps/web/src/App.tsx'], ['db/'])).toBe(false);
  });

  it('accepts a dependency manifest the issue did not declare, at any depth', () => {
    // Adding a library is normal implementation work; the manifest lives next to
    // the package in a monorepo, so an undeclared apps/api/package.json is fine.
    expect(scopeRespected(['apps/api/package.json', 'apps/api/src/x.ts'], ['apps/api/src/'])).toBe(
      true
    );
  });

  it('accepts the root lockfile alongside a declared change', () => {
    expect(scopeRespected(['pnpm-lock.yaml', 'db/x.sql'], ['db/'])).toBe(true);
  });

  it('accepts Rust and Python manifests by name', () => {
    expect(scopeRespected(['crates/ic-engine/Cargo.toml', 'Cargo.lock'], ['crates/'])).toBe(true);
    expect(scopeRespected(['pyproject.toml', 'uv.lock'], ['services/brain/'])).toBe(true);
  });
});

describe('isSharedFile', () => {
  it('treats manifests at any depth as shared', () => {
    expect(isSharedFile('apps/api/package.json')).toBe(true);
    expect(isSharedFile('Cargo.lock')).toBe(true);
    expect(isSharedFile('services/brain/pyproject.toml')).toBe(true);
  });

  it('does not treat an arbitrary source file as shared', () => {
    expect(isSharedFile('apps/web/src/App.tsx')).toBe(false);
    // A file merely named like a manifest inside a source tree still matches by
    // basename, but an unrelated .json does not.
    expect(isSharedFile('apps/web/src/config.json')).toBe(false);
  });
});

describe('hasAiTrailer', () => {
  it('flags an assistant co-author trailer', () => {
    expect(hasAiTrailer(['feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'])).toBe(true);
  });

  it('passes a clean message', () => {
    expect(hasAiTrailer(['feat: x\n\nJust a normal body.'])).toBe(false);
  });
});

describe('hasSecret', () => {
  it('catches an AWS access key id on an added line', () => {
    expect(hasSecret('+const k = "AKIAIOSFODNN7EXAMPLE";')).toBe(true);
  });

  it('ignores a removed line and the diff header', () => {
    expect(hasSecret('-const k = "AKIAIOSFODNN7EXAMPLE";')).toBe(false);
    expect(hasSecret('+++ b/AKIAIOSFODNN7EXAMPLE')).toBe(false);
  });
});
