import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { registerBuiltInResources } from '../resources';
import { resetResourceRegistry } from '../resources/registry';
import { irDigest } from './digest';
import { threeTier } from './fixtures';
import { IR_PATCH_VERSION, type IrPatch } from './patch';
import { previewContext, previewPatch, type PreviewResult } from './preview';

/**
 * One committed example of a preview payload, written by this suite and read by
 * anything that has to mirror the type in another language.
 *
 * The copilot's tool surface is being built in TypeScript, but the epic keeps
 * the door open for a Python or MCP implementation of the same contract, and a
 * field added on one side and not the other has to fail a test rather than a
 * user's diff card. Pinning the shape to a file is how the reasoning-scale
 * tables are held together across the same boundary.
 */

const FIXTURE = new URL('../../../../fixtures/ir/patch-preview.example.json', import.meta.url);

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

/**
 * Two fields are measurements of the run rather than of the architecture, and a
 * fixture carrying them would differ on every machine.
 */
function stable(result: PreviewResult): PreviewResult {
  return {
    ...result,
    preview: { ...result.preview, computedMs: 0, baselineCacheHit: false },
  };
}

function example(): PreviewResult {
  const ir = threeTier();
  const patch: IrPatch = {
    patchVersion: IR_PATCH_VERSION,
    basedOnIrDigest: irDigest(ir),
    summary: 'Make the primary database Multi-AZ',
    ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }],
  };
  // The region with a committed price list, so the example carries real cost
  // lines rather than an unpriced architecture.
  return stable(previewPatch(ir, patch, previewContext('us-east-1'))); // infracanvas-allow: no-hardcoded-region
}

describe('the committed preview example', () => {
  it('matches what previewPatch produces today', () => {
    const produced = `${JSON.stringify(example(), null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === '1') {
      mkdirSync(new URL('.', FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, produced);
    }

    // `git diff --exit-code fixtures/ir/patch-preview.example.json` in CI is
    // what turns a drift here into a failure nobody can miss.
    expect(readFileSync(FIXTURE, 'utf8')).toBe(produced);
  });

  it('carries every field of the payload, so a mirror of it cannot miss one', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as PreviewResult;

    expect(Object.keys(committed).sort()).toEqual([
      'inverse',
      'patchedIr',
      'patchedIrDigest',
      'preview',
    ]);
    expect(Object.keys(committed.preview).sort()).toEqual([
      'applicable',
      'assumptions',
      'availability',
      'basedOnIrDigest',
      'baselineCacheHit',
      'computedMs',
      'cost',
      'findings',
      'patchDigest',
      'previewVersion',
      'problems',
      'touchedNodeIds',
    ]);
    expect(committed.preview.cost.byResource.length).toBeGreaterThan(0);
    expect(committed.preview.cost.byResource[0]?.lines.length).toBeGreaterThan(0);
  });
});
