import { describe, expect, it } from 'vitest';
import { lookupSignature } from './signatures.js';

describe('lookupSignature', () => {
  it('maps a database driver to the engine it needs', () => {
    expect(lookupSignature('npm', 'pg')).toEqual({ category: 'datastore', capability: 'postgres' });
    expect(lookupSignature('pypi', 'asyncpg')).toEqual({
      category: 'datastore',
      capability: 'postgres',
    });
  });

  it('maps a web framework to an http server', () => {
    expect(lookupSignature('npm', 'express')?.capability).toBe('http-server');
    expect(lookupSignature('pypi', 'fastapi')?.capability).toBe('http-server');
  });

  it('leaves the capability unset for an ORM', () => {
    // An ORM says the data is relational but not which engine, and guessing is
    // how the wrong database gets provisioned.
    const prisma = lookupSignature('npm', 'prisma');

    expect(prisma?.category).toBe('orm');
    expect(prisma?.capability).toBeNull();
  });

  it('matches a Go module past its major version suffix', () => {
    // `pgx/v5` is the same dependency as `pgx` as far as infrastructure goes.
    expect(lookupSignature('go', 'github.com/jackc/pgx/v5')?.capability).toBe('postgres');
    expect(lookupSignature('go', 'github.com/gin-gonic/gin')?.capability).toBe('http-server');
  });

  it('matches case-insensitively', () => {
    expect(lookupSignature('pypi', 'Flask')?.capability).toBe('http-server');
  });

  it('does not confuse ecosystems that share a package name', () => {
    // `redis` is a cache client in npm and in pypi, but the lookup must not
    // fall through to another ecosystem's table for names that differ.
    expect(lookupSignature('npm', 'celery')).toBeNull();
    expect(lookupSignature('pypi', 'celery')?.capability).toBe('background-jobs');
  });

  it('returns null for a dependency it does not recognise', () => {
    expect(lookupSignature('npm', 'left-pad')).toBeNull();
  });

  it('does not match a Go prefix that is only a partial path segment', () => {
    expect(lookupSignature('go', 'github.com/lib/pquerystring')).toBeNull();
  });
});
