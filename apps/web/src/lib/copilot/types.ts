/**
 * Event and view types shared by the SSE client, the copilot store, and the panel.
 * Shapes mirror the API contract in epic-13 issue #132 and the preview deltas in #130.
 */

export type Completeness = 'complete' | 'partial';

export interface PreviewUnknown {
  resourceId: string;
  kind: string;
  dimension: 'cost' | 'availability' | 'rules';
  reason: string;
  side: 'before' | 'after' | 'both';
}

export interface CostLine {
  sku: string;
  description: string;
  monthlyUsd: number;
}

export interface ResourceCostDelta {
  resourceId: string;
  change: 'added' | 'removed' | 'changed';
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  lines: CostLine[];
}

export interface CostDelta {
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  completeness: Completeness;
  byResource: ResourceCostDelta[];
  unpriced: PreviewUnknown[];
}

export interface AvailabilityDelta {
  before: number;
  after: number;
  delta: number;
  downtimeMinutesBefore: number;
  downtimeMinutesAfter: number;
  weakestBefore: string;
  weakestAfter: string;
  completeness: Completeness;
  unmodelled: PreviewUnknown[];
}

export interface RuleFindingView {
  ruleId: string;
  pillar: string;
  severity: string;
  message: string;
  pointer: string;
  remediation: string;
}

export interface FindingDelta {
  appeared: RuleFindingView[];
  resolved: RuleFindingView[];
  unchangedCount: number;
}

export interface PatchPreview {
  previewVersion: number;
  basedOnIrDigest: string;
  patchDigest: string;
  applicable: boolean;
  problems: Array<{ pointer?: string; message: string }>;
  touchedNodeIds: string[];
  cost: CostDelta;
  availability: AvailabilityDelta;
  findings: FindingDelta;
  assumptions: Array<{ id: string; label: string; value: number; unit: string }>;
  baselineCacheHit: boolean;
  computedMs: number;
}

export interface ToolCallView {
  callId: string;
  tool: string;
  summary: string;
  /** Absent while the call is in flight. */
  ok?: boolean;
  durationMs?: number;
}

export interface CitationView {
  scheme: 'file' | 'sku' | 'prediction';
  target: string;
  verified: boolean;
  reason: string | null;
}

export interface ProposalView {
  proposalId: string;
  summary: string;
  /** Already rendered as sentences — never raw operation objects. */
  operations: string[];
  touchedNodeIds: string[];
  preview: PatchPreview;
  decision: 'pending' | 'accepted' | 'rejected' | 'stale';
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallView[];
  citations: CitationView[];
  proposal: ProposalView | null;
  status: 'streaming' | 'complete' | 'limit' | 'cancelled' | 'error';
  unverifiedCitations: number;
}

export type CopilotEvent =
  | { kind: 'token'; seq: number; text: string }
  | {
      kind: 'citation';
      seq: number;
      scheme: 'file' | 'sku' | 'prediction';
      target: string;
      verified: boolean;
      reason: string | null;
    }
  | { kind: 'tool_call'; seq: number; callId: string; tool: string; summary: string }
  | {
      kind: 'tool_result';
      seq: number;
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      durationMs: number;
    }
  | {
      kind: 'patch_proposed';
      seq: number;
      proposalId: string;
      patchDigest: string;
      summary: string;
      touchedNodeIds: string[];
      preview: PatchPreview;
      /** Sentences from the tool layer; absent on older payloads. */
      operations?: string[];
    }
  | { kind: 'limit'; seq: number; limit: string; message: string }
  | { kind: 'error'; seq: number; code: string; message: string }
  | {
      kind: 'done';
      seq: number;
      finish: 'complete' | 'limit' | 'cancelled' | 'error';
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      unverifiedCitations: number;
    }
  | { kind: 'snapshot'; seq: number; message: CopilotMessage };
