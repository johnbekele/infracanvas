import { describe, expect, it } from 'vitest';
import {
  InvalidGitHubParamError,
  assertBranch,
  assertOwner,
  assertRepo,
  assertRepoCoordinates,
  encodeBranch,
} from './github-params.js';

describe('assertOwner', () => {
  it('accepts a valid GitHub login', () => {
    expect(assertOwner('johnbekele')).toBe('johnbekele');
    expect(assertOwner('a')).toBe('a');
    expect(assertOwner('my-org-123')).toBe('my-org-123');
  });

  it('rejects path traversal that would escape the repos path', () => {
    // The attack this validation exists to stop: the resulting URL would leave
    // /repos/ entirely while still carrying the caller's OAuth token.
    expect(() => assertOwner('..')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner('../../user')).toThrow(InvalidGitHubParamError);
  });

  it('rejects separators and credential syntax that could alter the URL authority', () => {
    expect(() => assertOwner('evil.com/x')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner('user@evil.com')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner('a%2f..')).toThrow(InvalidGitHubParamError);
  });

  it('rejects leading and trailing hyphens and over-long logins', () => {
    expect(() => assertOwner('-lead')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner('trail-')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner('a'.repeat(40))).toThrow(InvalidGitHubParamError);
  });

  it('rejects empty and non-string input', () => {
    expect(() => assertOwner('')).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner(undefined)).toThrow(InvalidGitHubParamError);
    expect(() => assertOwner(123)).toThrow(InvalidGitHubParamError);
  });
});

describe('assertRepo', () => {
  it('accepts valid repository names including dots and underscores', () => {
    expect(assertRepo('infracanvas')).toBe('infracanvas');
    expect(assertRepo('my.repo_name-1')).toBe('my.repo_name-1');
  });

  it('rejects relative path segments', () => {
    expect(() => assertRepo('.')).toThrow(InvalidGitHubParamError);
    expect(() => assertRepo('..')).toThrow(InvalidGitHubParamError);
  });

  it('rejects separators and over-long names', () => {
    expect(() => assertRepo('a/b')).toThrow(InvalidGitHubParamError);
    expect(() => assertRepo('a'.repeat(101))).toThrow(InvalidGitHubParamError);
  });
});

describe('assertBranch', () => {
  it('accepts ordinary and nested branch names', () => {
    expect(assertBranch('main')).toBe('main');
    expect(assertBranch('feature/new-thing')).toBe('feature/new-thing');
  });

  it('rejects refs that traverse or use reflog syntax', () => {
    expect(() => assertBranch('../../etc')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('main@{1}')).toThrow(InvalidGitHubParamError);
  });

  it('rejects characters git forbids in a ref name', () => {
    expect(() => assertBranch('has space')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('caret^')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('tilde~')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('colon:')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('question?')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('null\u0000byte')).toThrow(InvalidGitHubParamError);
  });

  it('rejects invalid ref boundaries and segments', () => {
    expect(() => assertBranch('/leading')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('trailing/')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('a//b')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('.hidden')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('feature/.hidden')).toThrow(InvalidGitHubParamError);
    expect(() => assertBranch('branch.lock')).toThrow(InvalidGitHubParamError);
  });

  it('rejects over-long refs', () => {
    expect(() => assertBranch('a'.repeat(256))).toThrow(InvalidGitHubParamError);
  });
});

describe('encodeBranch', () => {
  it('preserves ref separators while encoding each segment', () => {
    expect(encodeBranch('feature/new-thing')).toBe('feature/new-thing');
    expect(encodeBranch('feature/a+b')).toBe('feature/a%2Bb');
  });
});

describe('assertRepoCoordinates', () => {
  it('returns both validated values', () => {
    expect(assertRepoCoordinates({ owner: 'johnbekele', repo: 'infracanvas' })).toEqual({
      owner: 'johnbekele',
      repo: 'infracanvas',
    });
  });

  it('reports which parameter was invalid', () => {
    expect(() => assertRepoCoordinates({ owner: '..', repo: 'ok' })).toThrow(/owner/);
    expect(() => assertRepoCoordinates({ owner: 'ok', repo: 'a/b' })).toThrow(/repo/);
  });
});
