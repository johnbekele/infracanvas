/**
 * What the copilot is doing, in English.
 *
 * The transcript stores these and the UI renders them; tool arguments are
 * deliberately never stored or shown, because an argument can carry a whole
 * patch and the proposal row already holds it. Building the sentence here
 * rather than in the client keeps one wording for every caller of the tool
 * layer, including the MCP server.
 */

function nodeId(args: Record<string, unknown>): string {
  return typeof args.node_id === 'string' ? args.node_id : 'a resource';
}

function opCount(args: Record<string, unknown>): number {
  return Array.isArray(args.ops) ? args.ops.length : 0;
}

export function summariseCall(tool: string, rawArgs: unknown): string {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<
    string,
    unknown
  >;

  switch (tool) {
    case 'read_architecture':
      return 'Reading the architecture';
    case 'explain_node':
      return `Looking at ${nodeId(args)}`;
    case 'price_change':
      return `Pricing a change of ${opCount(args)} operation${opCount(args) === 1 ? '' : 's'}`;
    case 'compare_options':
      return `Comparing ${Array.isArray(args.options) ? args.options.length : 0} options`;
    case 'propose_patch':
      return typeof args.summary === 'string' ? `Proposing: ${args.summary}` : 'Proposing a change';
    case 'apply_patch':
      return 'Applying an accepted proposal';
    default:
      return `Calling ${tool}`;
  }
}

export function summariseResult(tool: string, result: unknown): string {
  const record = (typeof result === 'object' && result !== null ? result : {}) as Record<
    string,
    unknown
  >;

  switch (tool) {
    case 'read_architecture': {
      const count = typeof record.node_count === 'number' ? record.node_count : 0;
      const monthly = typeof record.monthly_usd === 'number' ? record.monthly_usd : null;
      return monthly === null
        ? `${count} resources, none of which could be priced`
        : `${count} resources, $${monthly.toFixed(2)} a month`;
    }
    case 'explain_node':
      return `Read ${typeof record.node_id === 'string' ? record.node_id : 'a resource'}`;
    case 'price_change':
      return describeDelta(record);
    case 'compare_options':
      return `Priced ${Array.isArray(record.options) ? record.options.length : 0} options`;
    case 'propose_patch':
      return record.accepted === true
        ? 'Proposed a change for you to review'
        : 'The change was refused; the problems say why';
    case 'apply_patch':
      return typeof record.message === 'string' ? record.message : 'Done';
    default:
      return 'Done';
  }
}

function describeDelta(record: Record<string, unknown>): string {
  const cost = record.cost as { monthlyUsdDelta?: number } | undefined;
  if (typeof cost?.monthlyUsdDelta !== 'number') return 'Priced a change';
  const delta = cost.monthlyUsdDelta;
  if (delta === 0) return 'No change to the monthly cost';
  return delta > 0
    ? `$${delta.toFixed(2)} a month more`
    : `$${Math.abs(delta).toFixed(2)} a month less`;
}
