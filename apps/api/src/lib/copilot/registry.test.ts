import { describe, expect, it } from 'vitest';

import { ToolArgumentError } from './errors.js';
import { COPILOT_TOOLS, toolNamed } from './registry.js';

/**
 * The registry is the contract. `020-copilot-tool-surface.md` fixes these six
 * names and shapes so that the conversation loop, the MCP server in #118 and
 * any later implementation in another language bind to one surface, and these
 * tests are what stops the surface drifting a field at a time.
 */

describe('the copilot tool registry', () => {
  it('carries exactly the six tools the spec names', () => {
    expect(COPILOT_TOOLS.map((tool) => tool.name)).toEqual([
      'read_architecture',
      'explain_node',
      'price_change',
      'compare_options',
      'propose_patch',
      'apply_patch',
    ]);
  });

  it('declares exactly one tool as mutating', () => {
    const mutating = COPILOT_TOOLS.filter((tool) => tool.mutates);

    expect(mutating.map((tool) => tool.name)).toEqual(['apply_patch']);
  });

  it('describes every tool, since the description is what a model chooses by', () => {
    for (const tool of COPILOT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('accepts no experiment id, user id or credential in any argument', () => {
    // A model can write anything into a tool call. Every parser builds its
    // result field by field, so a smuggled scope is dropped rather than
    // honoured, and the turn stays bound to the experiment it was opened for.
    const smuggled = {
      experiment_id: '00000000-0000-4000-8000-000000000000',
      user_id: '00000000-0000-4000-8000-000000000001',
      api_key: 'sk-not-a-real-key',
      token: 'not-a-real-token',
      node_id: 'rds-primary',
      proposal_id: '00000000-0000-4000-8000-000000000002',
      question: 'Which is cheaper?',
      summary: 'A change',
      rationale: 'Because.',
      ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }],
      options: [
        { label: 'a', ops: [{ op: 'set_param', nodeId: 'a', param: 'b', value: 1 }] },
        { label: 'b', ops: [{ op: 'set_param', nodeId: 'a', param: 'b', value: 2 }] },
      ],
    };

    for (const tool of COPILOT_TOOLS) {
      const parsed = tool.parse(smuggled) as Record<string, unknown>;
      expect(Object.keys(parsed)).not.toContain('experiment_id');
      expect(Object.keys(parsed)).not.toContain('user_id');
      expect(Object.keys(parsed)).not.toContain('api_key');
      expect(Object.keys(parsed)).not.toContain('token');
    }
  });

  it('refuses a comparison of more than four options before any pricing', () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      label: `Option ${index}`,
      ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }],
    }));

    expect(() =>
      toolNamed('compare_options')?.parse({ question: 'Which?', options: five })
    ).toThrow(ToolArgumentError);
  });

  it('refuses a patch of more than fifty operations and one of none', () => {
    const op = { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true };
    const parse = toolNamed('price_change')?.parse;

    expect(() => parse?.({ ops: Array.from({ length: 51 }, () => op) })).toThrow(ToolArgumentError);
    expect(() => parse?.({ ops: [] })).toThrow(ToolArgumentError);
  });

  it('refuses a summary or rationale longer than the diff card can hold', () => {
    const op = { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true };
    const parse = toolNamed('propose_patch')?.parse;

    expect(() => parse?.({ ops: [op], summary: 'x'.repeat(201), rationale: 'ok' })).toThrow(
      ToolArgumentError
    );
    expect(() => parse?.({ ops: [op], summary: 'ok', rationale: 'x'.repeat(2001) })).toThrow(
      ToolArgumentError
    );
    expect(() => parse?.({ ops: [op], summary: '  ', rationale: 'ok' })).toThrow(ToolArgumentError);
  });
});
