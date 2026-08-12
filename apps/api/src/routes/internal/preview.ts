import { Router, type Request, type Response } from 'express';
import {
  createBaselineCache,
  createPreviewCache,
  defaultAssumptions,
  previewPatch,
  registerBuiltInResources,
  type Assumption,
  type IrPatch,
  type PreviewContext,
} from '@infracanvas/core';
import { validateIr, type ArchitectureIr } from '@infracanvas/ir-schema';

import { logError } from '../../lib/log.js';

/**
 * The preview plane, as one pure endpoint.
 *
 * The prediction models are TypeScript and live in `packages/core`, which this
 * process already depends on. Anything else that needs a priced patch - the
 * copilot's tool surface, an MCP server, a second implementation in another
 * language - reaches them through here rather than reimplementing them, because
 * two cost models drift silently and the accuracy fixtures that pin these
 * numbers to the AWS Pricing Calculator live in the TypeScript suite.
 *
 * The endpoint is deliberately pure: the caller supplies the document and the
 * patch, and this route touches no database and has no notion of a user. There
 * is therefore no ownership check in it to get wrong and no path by which it
 * could return somebody else's architecture.
 */

// Registration is a call rather than an import side effect, so it happens once
// here where the module is loaded rather than wherever a bundler kept it.
registerBuiltInResources();

/**
 * Process-local and content-addressed. The keys fold in the price snapshot, the
 * IR version and the assumption set, so an entry cannot go stale and there is
 * nothing to invalidate. Shared across requests deliberately: the four options
 * of a comparison are four requests about one document, and the baseline is the
 * expensive half of each.
 */
const baselineCache = createBaselineCache();
const previewCache = createPreviewCache();

interface PreviewRequestBody {
  ir?: unknown;
  patch?: unknown;
  region?: unknown;
  assumptions?: unknown;
}

class BadRequestError extends Error {
  readonly problems: { pointer: string; message: string }[];

  constructor(message: string, problems: { pointer: string; message: string }[] = []) {
    super(message);
    this.name = 'BadRequestError';
    this.problems = problems;
  }
}

function readIr(value: unknown): ArchitectureIr {
  const validation = validateIr(value);
  if (!validation.valid) {
    throw new BadRequestError(
      'The body must carry a valid architecture IR document under "ir".',
      validation.problems.map((problem) => ({
        pointer: `/ir${problem.pointer}`,
        message: problem.message,
      }))
    );
  }
  return validation.document;
}

/**
 * Shape only. Whether the operations apply is the preview's answer to give -
 * `applicable: false` with problems is a useful reply and a 400 is not.
 */
function readPatch(value: unknown): IrPatch {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('The body must carry a patch under "patch".');
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.ops) || typeof candidate.basedOnIrDigest !== 'string') {
    throw new BadRequestError('A patch needs "ops" and "basedOnIrDigest".');
  }
  return value as IrPatch;
}

function readAssumptions(value: unknown): Assumption[] {
  if (value === undefined) return [...defaultAssumptions().values()];
  if (!Array.isArray(value)) throw new BadRequestError('"assumptions" must be a list.');

  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Assumption).id !== 'string' ||
      typeof (entry as Assumption).value !== 'number'
    ) {
      throw new BadRequestError('Every assumption needs an id and a numeric value.');
    }
  }
  return value as Assumption[];
}

function contextFor(ir: ArchitectureIr, body: PreviewRequestBody): PreviewContext {
  if (body.region !== undefined && typeof body.region !== 'string') {
    throw new BadRequestError('"region" must be a string.');
  }
  return {
    // The document states the region it is drawn for, so a caller that omits
    // one is priced where the architecture actually is rather than somewhere a
    // default happened to name.
    region: (body.region as string | undefined) ?? ir.region,
    assumptions: readAssumptions(body.assumptions),
    baselineCache,
    previewCache,
  };
}

export function handlePreview(req: Request, res: Response): void {
  const body = (req.body ?? {}) as PreviewRequestBody;

  try {
    const ir = readIr(body.ir);
    const patch = readPatch(body.patch);
    res.json(previewPatch(ir, patch, contextFor(ir, body)));
  } catch (error) {
    if (error instanceof BadRequestError) {
      res.status(400).json({ error: error.message, problems: error.problems });
      return;
    }
    logError('Preview failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const router: Router = Router();
router.post('/preview', handlePreview);

export default router;
