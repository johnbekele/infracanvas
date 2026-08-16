import type { CopilotDeps } from './deps.js';
import {
  applyPatch,
  compareOptions,
  explainNode,
  priceChange,
  proposePatch,
  readArchitecture,
} from './tools.js';
import {
  applyPatchArgs,
  compareOptionsArgs,
  explainNodeArgs,
  priceChangeArgs,
  proposePatchArgs,
  readArchitectureArgs,
} from './validate.js';

/**
 * The one list.
 *
 * The run loop registers from it and the MCP server in #118 serves from it, so
 * a tool that is in neither place is in neither list. `mutates` is declared
 * rather than inferred, and a test asserts that exactly one entry sets it, so
 * adding a seventh tool that writes forces a decision instead of slipping in.
 */

export interface ToolSpec {
  name: string;
  /** Parses and bounds-checks whatever the model sent, or throws `ToolArgumentError`. */
  parse: (raw: unknown) => unknown;
  handler: (deps: CopilotDeps, args: never) => Promise<unknown>;
  /**
   * Whether the tool changes the architecture. `propose_patch` writes a
   * proposal row and is still false here: a proposal is a card a user has yet
   * to answer, and treating it as a mutation would mean either refusing it
   * under a read-only principal or letting a real write through under the same
   * flag. Exactly one tool writes the document.
   */
  mutates: boolean;
  /** Shown to the model. The only prose in this module, and part of the contract. */
  description: string;
}

export const COPILOT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'read_architecture',
    parse: readArchitectureArgs,
    handler: readArchitecture as ToolSpec['handler'],
    mutates: false,
    description:
      'Read the current architecture: the whole document, an index of its nodes and edges, and what it costs a month.',
  },
  {
    name: 'explain_node',
    parse: explainNodeArgs,
    handler: explainNode as ToolSpec['handler'],
    mutates: false,
    description:
      'Explain one resource: its parameters, what it is connected to, what it costs line by line, its availability, the Well-Architected findings against it, and the repository paths behind it.',
  },
  {
    name: 'price_change',
    parse: priceChangeArgs,
    handler: priceChange as ToolSpec['handler'],
    mutates: false,
    description:
      'Price a hypothetical change without recording it. Use this while thinking; it stores nothing.',
  },
  {
    name: 'compare_options',
    parse: compareOptionsArgs,
    handler: compareOptions as ToolSpec['handler'],
    mutates: false,
    description:
      'Price two to four ways of meeting one goal against the same architecture, so their cost, availability and findings can be compared with each other and with doing nothing.',
  },
  {
    name: 'propose_patch',
    parse: proposePatchArgs,
    handler: proposePatch as ToolSpec['handler'],
    mutates: false,
    description:
      'Propose a change to the architecture. The change is applied and priced in a sandbox and shown to the user as a diff card; the architecture itself is not touched.',
  },
  {
    name: 'apply_patch',
    parse: applyPatchArgs,
    handler: applyPatch as ToolSpec['handler'],
    mutates: true,
    description:
      'Apply a proposal the user has accepted. Refuses anything the user has not accepted, and refuses a proposal priced against an architecture that has since moved.',
  },
];

export function toolNamed(name: string): ToolSpec | undefined {
  return COPILOT_TOOLS.find((tool) => tool.name === name);
}

/**
 * Serve one call, and record that it was served.
 *
 * The record is appended here rather than by the caller so that a turn's
 * transcript is a fact about what the tool layer did, not about what the
 * runtime remembered to log. Failures are recorded too: a model that called
 * `apply_patch` on an unaccepted proposal is exactly what a reader of the
 * transcript needs to see.
 */
export async function invokeTool(
  deps: CopilotDeps,
  name: string,
  rawArgs: unknown
): Promise<unknown> {
  const tool = toolNamed(name);
  if (tool === undefined) throw new Error(`No tool named ${name}`);

  const startedAt = new Date().toISOString();
  const started = performance.now();

  try {
    const args = tool.parse(rawArgs);
    const result = await tool.handler(deps, args as never);
    deps.calls.push({
      name,
      arguments: args,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      ok: true,
    });
    return result;
  } catch (error) {
    deps.calls.push({
      name,
      arguments: rawArgs,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      ok: false,
      error: error instanceof Error ? error.message : 'The tool failed',
    });
    throw error;
  }
}
