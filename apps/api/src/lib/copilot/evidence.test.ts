import { describe, expect, it } from 'vitest';
import { PROFILE_SCHEMA_VERSION, proposeArchitecture, type AppProfile } from '@infracanvas/core';

import { evidenceForNode } from './evidence.js';

/**
 * A profile with one deployable component that declares a database, which is
 * the smallest thing synthesis will draw both a service and a database for.
 */
function profile(): AppProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha: 'b7a1f0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',
    ref: 'refs/heads/main',
    analysedAt: '2026-08-12T00:00:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 4096, share: 1 }],
    components: [
      {
        path: 'services/api',
        name: 'api',
        kind: 'api',
        ecosystems: ['npm'],
        manifestPaths: ['services/api/package.json'],
        dependencyCount: 2,
        capabilities: ['http-server', 'postgres'],
        dependencies: [
          {
            name: 'express',
            ecosystem: 'npm',
            category: 'web-framework',
            capability: 'http-server',
            sourcePath: 'services/api/package.json',
          },
          {
            name: 'pg',
            ecosystem: 'npm',
            category: 'datastore',
            capability: 'postgres',
            sourcePath: 'services/api/package.json',
          },
        ],
        dockerfiles: ['services/api/Dockerfile'],
        exposedPorts: [3000],
        composeService: null,
        deployable: true,
      },
    ],
    dependencies: [],
    composeServices: [],
    containerisation: {
      dockerfiles: ['services/api/Dockerfile'],
      composeFiles: [],
      exposedPorts: [3000],
    },
    fileCount: 12,
    totalBytes: 4096,
    notes: [],
  };
}

describe('evidence for a node', () => {
  it('cites the manifests and Dockerfiles the analysis actually read', () => {
    const proposal = proposeArchitecture(profile(), 'shop');
    const compute = proposal.decisions.find((decision) => decision.nodeId.startsWith('compute-'));
    expect(compute).toBeDefined();

    const evidence = evidenceForNode(profile(), 'shop', compute?.nodeId as string);

    expect(evidence.map((citation) => citation.path)).toEqual(compute?.evidence);
    expect(evidence.every((citation) => citation.reason.length > 0)).toBe(true);
  });

  it('returns nothing rather than a plausible path for a node the profile cannot account for', () => {
    // A node the user drew by hand, or one whose id was changed. Either way
    // there is no path to cite, and inventing one is the failure a citation
    // exists to prevent.
    expect(evidenceForNode(profile(), 'shop', 'rds-primary')).toEqual([]);
  });

  it('returns nothing when no repository was analysed at all', () => {
    expect(evidenceForNode(null, 'shop', 'compute-services-api')).toEqual([]);
  });
});
