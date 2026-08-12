import { describe, expect, it } from 'vitest';
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type ArchitectureProposal,
} from '@infracanvas/core';
import type { Analysis } from '@/lib/api/repositories';
import { latestSucceeded, proposalFor } from './proposal';

const profile: AppProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  commitSha: 'a'.repeat(40),
  ref: 'main',
  analysedAt: '2026-08-12T00:00:00.000Z',
  languages: [{ name: 'TypeScript', bytes: 1000, share: 1 }],
  components: [
    {
      path: 'apps/api',
      name: 'api',
      kind: 'api',
      ecosystems: ['npm'],
      manifestPaths: ['apps/api/package.json'],
      dependencyCount: 1,
      capabilities: ['http-server'],
      dependencies: [
        {
          name: 'express',
          ecosystem: 'npm',
          category: 'web-framework',
          capability: 'http-server',
          sourcePath: 'apps/api/package.json',
        },
      ],
      dockerfiles: ['apps/api/Dockerfile'],
      exposedPorts: [3000],
      composeService: null,
      deployable: true,
    },
  ],
  dependencies: [
    {
      name: 'express',
      ecosystem: 'npm',
      category: 'web-framework',
      capability: 'http-server',
      sourcePath: 'apps/api/package.json',
    },
  ],
  composeServices: [],
  containerisation: {
    dockerfiles: ['apps/api/Dockerfile'],
    composeFiles: [],
    exposedPorts: [3000],
  },
  fileCount: 10,
  totalBytes: 1000,
  notes: [],
};

const stored: ArchitectureProposal = {
  name: 'shop architecture',
  nodes: [],
  edges: [],
  decisions: [
    {
      nodeId: 'compute-apps-api',
      title: 'Service for api',
      rationale: 'Recorded when the analysis ran.',
      evidence: ['apps/api/Dockerfile'],
      confidence: 'high',
    },
  ],
  gaps: [],
};

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    repositoryId: '22222222-2222-2222-2222-222222222222',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    status: 'succeeded',
    profile,
    architecture: null,
    error: null,
    startedAt: '2026-08-12T00:00:00.000Z',
    finishedAt: '2026-08-12T00:00:10.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:10.000Z',
    ...overrides,
  };
}

describe('latestSucceeded', () => {
  it('ignores a failed run recorded after a successful one', () => {
    const runs = [
      analysis({ id: 'newest', status: 'failed', profile: null, error: 'GitHub said no' }),
      analysis({ id: 'older' }),
    ];

    expect(latestSucceeded(runs)?.id).toBe('older');
  });

  it('returns null when nothing has succeeded', () => {
    expect(latestSucceeded([analysis({ status: 'running', profile: null })])).toBeNull();
    expect(latestSucceeded(undefined)).toBeNull();
    expect(latestSucceeded([])).toBeNull();
  });
});

describe('proposalFor', () => {
  it('returns the stored proposal with its rationale and evidence intact', () => {
    const proposal = proposalFor(analysis({ architecture: stored }), 'shop');

    expect(proposal).toBe(stored);
    expect(proposal?.decisions[0].rationale).toBe('Recorded when the analysis ran.');
    expect(proposal?.decisions[0].evidence).toEqual(['apps/api/Dockerfile']);
  });

  it('recomputes from the profile for a run stored before proposals were persisted', () => {
    const proposal = proposalFor(analysis({ architecture: null }), 'shop');

    expect(proposal?.name).toBe('shop architecture');
    expect(proposal?.nodes.some((node) => node.componentPath === 'apps/api')).toBe(true);
  });

  it('prefers the stored proposal over recomputing it', () => {
    // The stored proposal has no nodes; a recomputed one would. Trusting the
    // recomputed shape here would silently replace the reasoning the user was
    // shown when the analysis ran.
    const proposal = proposalFor(analysis({ architecture: stored }), 'shop');

    expect(proposal?.nodes).toEqual([]);
  });

  it('returns null when there is neither a proposal nor a profile', () => {
    expect(proposalFor(analysis({ profile: null, architecture: null }), 'shop')).toBeNull();
    expect(proposalFor(null, 'shop')).toBeNull();
  });

  it('returns null before the repository name is known', () => {
    // Without the name the proposal would be titled from `undefined`, which is
    // worse than waiting one render for the repository to load.
    expect(proposalFor(analysis(), undefined)).toBeNull();
  });
});
