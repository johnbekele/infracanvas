import type { IrPatchOp } from '@infracanvas/core';

import { ToolArgumentError } from './errors.js';
import {
  MAX_COMPARE_OPTIONS,
  MAX_OPS_PER_TOOL_CALL,
  type ApplyPatchArgs,
  type CompareOptionsArgs,
  type ExplainNodeArgs,
  type PriceChangeArgs,
  type ProposePatchArgs,
} from './models.js';

/**
 * The bounds `020-copilot-tool-surface.md` states as Pydantic `Field`
 * constraints, checked before any work is done.
 *
 * They are refusals rather than clamps. A comparison of five options silently
 * truncated to four answers a question nobody asked, and the model has no way
 * to see that it happened.
 *
 * Whether an operation is a valid `IrPatchOp` is not decided here: the patch
 * protocol says so per operation, with a pointer and a reason, and duplicating
 * that check would give two answers to one question.
 */

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ToolArgumentError(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ToolArgumentError(field, `${field} must not be empty`);
  if (trimmed.length > max) {
    throw new ToolArgumentError(field, `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function ops(value: unknown, field: string): IrPatchOp[] {
  if (!Array.isArray(value)) throw new ToolArgumentError(field, `${field} must be a list`);
  if (value.length < 1) throw new ToolArgumentError(field, `${field} must contain an operation`);
  if (value.length > MAX_OPS_PER_TOOL_CALL) {
    throw new ToolArgumentError(field, `${field} must contain at most ${MAX_OPS_PER_TOOL_CALL}`);
  }
  for (const op of value) {
    if (typeof op !== 'object' || op === null) {
      throw new ToolArgumentError(field, `every entry of ${field} must be an operation object`);
    }
  }
  return value as IrPatchOp[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ToolArgumentError(name, `${name} arguments must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readArchitectureArgs(raw: unknown): Record<string, never> {
  object(raw ?? {}, 'read_architecture');
  return {};
}

export function explainNodeArgs(raw: unknown): ExplainNodeArgs {
  const args = object(raw, 'explain_node');
  return { node_id: text(args.node_id, 'node_id', 1, 200) };
}

export function priceChangeArgs(raw: unknown): PriceChangeArgs {
  const args = object(raw, 'price_change');
  return { ops: ops(args.ops, 'ops') };
}

export function proposePatchArgs(raw: unknown): ProposePatchArgs {
  const args = object(raw, 'propose_patch');
  return {
    ops: ops(args.ops, 'ops'),
    summary: text(args.summary, 'summary', 1, 200),
    rationale: text(args.rationale, 'rationale', 1, 2000),
  };
}

export function compareOptionsArgs(raw: unknown): CompareOptionsArgs {
  const args = object(raw, 'compare_options');
  const question = text(args.question, 'question', 1, 500);

  if (!Array.isArray(args.options))
    throw new ToolArgumentError('options', 'options must be a list');
  if (args.options.length < 2) {
    throw new ToolArgumentError('options', 'a comparison needs at least two options');
  }
  if (args.options.length > MAX_COMPARE_OPTIONS) {
    throw new ToolArgumentError(
      'options',
      `a comparison may have at most ${MAX_COMPARE_OPTIONS} options`
    );
  }

  return {
    question,
    options: args.options.map((option, index) => {
      const entry = object(option, `options/${index}`);
      return {
        label: text(entry.label, `options/${index}/label`, 1, 80),
        ops: ops(entry.ops, `options/${index}/ops`),
      };
    }),
  };
}

/** Loose on purpose: a store miss is the same answer as a malformed id. */
export function applyPatchArgs(raw: unknown): ApplyPatchArgs {
  const args = object(raw, 'apply_patch');
  return { proposal_id: text(args.proposal_id, 'proposal_id', 1, 200) };
}
