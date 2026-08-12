import { validateIr } from '@infracanvas/ir-schema';

import type { ChatMessage, ChatModel } from './chat-model.js';
import type { CopilotDeps } from './deps.js';
import { ExperimentNotFoundError } from './errors.js';
import type { CopilotEvent, FinishReason, ToolCallSummary } from './events.js';
import { eventFor, GroundedStream, GroundingLedger } from './grounding.js';
import type { PatchProposal } from './models.js';
import { COPILOT_SYSTEM_PROMPT } from './prompt.js';
import { COPILOT_TOOLS, invokeTool } from './registry.js';
import { summariseCall, summariseResult } from './summaries.js';

/**
 * One turn.
 *
 * Every limit here is a bounded end rather than an exception: a truncated but
 * honest answer is more use than a stack trace, and the failure being guarded
 * against - a loop calling `price_change` forty times - is a cost the user pays
 * on their own key.
 */

export const MAX_TOOL_CALLS = 12;
export const MAX_PROPOSALS_PER_TURN = 3;
export const TURN_WALL_CLOCK_MS = 120_000;
export const PER_TOOL_TIMEOUT_MS = 10_000;
/** Oldest turns are dropped first, and the drop is stated rather than hidden. */
export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARS = 24_000;

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnRequest {
  message: string;
  history: TurnMessage[];
}

export type RefusalCode =
  | 'experiment_not_found'
  | 'no_llm_credential'
  | 'no_architecture'
  | 'invalid_architecture'
  | 'budget_exceeded';

export interface TurnRefusal {
  code: RefusalCode;
  message: string;
  status: number;
}

export interface TurnContext {
  deps: CopilotDeps;
  model: ChatModel;
  modelName: string;
}

/**
 * Everything that can stop a turn before it starts.
 *
 * Returned rather than thrown, because every one of these is a normal state a
 * new user passes through, and because each has to reach the client as a status
 * code with a body it can act on rather than as an error event inside a 200 -
 * once a stream is open, a refusal looks like a failure of the answer.
 */
export async function checkPreconditions(
  deps: CopilotDeps,
  model: { model: ChatModel; modelName: string } | null
): Promise<TurnRefusal | TurnContext> {
  let ir;
  try {
    ir = (await deps.store.experiment(deps.scope)).ir;
  } catch (error) {
    if (error instanceof ExperimentNotFoundError) {
      return {
        code: 'experiment_not_found',
        message: 'No such architecture.',
        status: 404,
      };
    }
    throw error;
  }

  if (ir.nodes.length === 0) {
    return {
      code: 'no_architecture',
      message:
        'This experiment has no architecture yet. Draw one on the canvas, or analyse a repository, and then ask again.',
      status: 409,
    };
  }

  const validation = validateIr(ir);
  if (!validation.valid) {
    return {
      code: 'invalid_architecture',
      message: 'This architecture does not validate, so nothing can be priced against it.',
      status: 409,
    };
  }

  if (model === null) {
    // Written as an instruction rather than as the name of an exception: the
    // user has to go and add a provider, and the message says so.
    return {
      code: 'no_llm_credential',
      message:
        'The copilot needs a model. Add an OpenAI key, or point it at a local Ollama server, in Settings, and then ask again.',
      status: 409,
    };
  }

  return { deps, model: model.model, modelName: model.modelName };
}

function history(request: TurnRequest): ChatMessage[] {
  const recent = request.history.slice(-MAX_HISTORY_MESSAGES);
  const kept: ChatMessage[] = [];
  let chars = 0;

  // Newest first while measuring, so the turn the user is answering survives a
  // long transcript rather than being the one dropped.
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (chars + message.content.length > MAX_HISTORY_CHARS) break;
    chars += message.content.length;
    kept.unshift({ role: message.role, content: message.content });
  }

  if (kept.length < request.history.length) {
    kept.unshift({
      role: 'system',
      content: `Earlier messages in this conversation were dropped to fit the context; ${request.history.length - kept.length} are missing.`,
    });
  }
  return kept;
}

interface TurnState {
  seq: number;
  toolCalls: ToolCallSummary[];
  proposals: number;
  inputTokens: number;
  outputTokens: number;
  unverified: number;
  proposalId: string | null;
}

/**
 * The turn, as a stream of events.
 *
 * `cancelled` is polled between events and before every tool call, so a user
 * who closes the panel stops paying for the turn within one step rather than at
 * the end of it.
 */
export async function* runTurn(
  context: TurnContext,
  request: TurnRequest,
  cancelled: () => boolean = () => false
): AsyncGenerator<CopilotEvent> {
  const started = Date.now();
  const ledger = new GroundingLedger();
  const grounded = new GroundedStream(ledger);
  const state: TurnState = {
    seq: 0,
    toolCalls: [],
    proposals: 0,
    inputTokens: 0,
    outputTokens: 0,
    unverified: 0,
    proposalId: null,
  };

  const next = (): number => {
    state.seq += 1;
    return state.seq;
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: COPILOT_SYSTEM_PROMPT },
    ...history(request),
    { role: 'user', content: request.message },
  ];

  const controller = new AbortController();
  let finish: FinishReason = 'complete';
  let limitEvent: CopilotEvent | null = null;

  try {
    // One iteration per model turn: the model speaks, and if it asked for tools
    // their results are appended and it speaks again.
    for (let round = 0; round <= MAX_TOOL_CALLS; round += 1) {
      if (cancelled()) {
        finish = 'cancelled';
        break;
      }
      if (Date.now() - started > TURN_WALL_CLOCK_MS) {
        finish = 'limit';
        limitEvent = {
          kind: 'limit',
          seq: next(),
          limit: 'wall_clock',
          message: 'This turn ran for two minutes and was stopped.',
        };
        break;
      }

      const requested: { callId: string; name: string; arguments: string }[] = [];
      let text = '';

      for await (const chunk of context.model.stream(
        {
          model: context.modelName,
          messages,
          tools: COPILOT_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        },
        controller.signal
      )) {
        if (cancelled()) {
          controller.abort();
          finish = 'cancelled';
          break;
        }

        if (chunk.kind === 'usage') {
          state.inputTokens += chunk.inputTokens;
          state.outputTokens += chunk.outputTokens;
          continue;
        }
        if (chunk.kind === 'tool_call') {
          requested.push(chunk);
          continue;
        }

        text += chunk.text;
        for (const entry of grounded.push(chunk.text)) {
          if (entry.kind === 'citation' && entry.verified !== true) state.unverified += 1;
          yield eventFor(entry, next());
        }
      }

      for (const entry of grounded.flush()) yield eventFor(entry, next());
      if (finish === 'cancelled') break;

      if (requested.length === 0) break;

      if (state.toolCalls.length + requested.length > MAX_TOOL_CALLS) {
        finish = 'limit';
        limitEvent = {
          kind: 'limit',
          seq: next(),
          limit: 'tool_calls',
          message: `This turn reached its ceiling of ${MAX_TOOL_CALLS} tool calls.`,
        };
        break;
      }

      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: requested.map((call) => ({
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        })),
      });

      let stop = false;
      for (const call of requested) {
        if (cancelled()) {
          finish = 'cancelled';
          stop = true;
          break;
        }

        const args = parseArguments(call.arguments);
        yield {
          kind: 'tool_call',
          seq: next(),
          callId: call.callId,
          tool: call.name,
          summary: summariseCall(call.name, args),
        };

        if (call.name === 'propose_patch' && state.proposals >= MAX_PROPOSALS_PER_TURN) {
          finish = 'limit';
          limitEvent = {
            kind: 'limit',
            seq: next(),
            limit: 'proposals',
            message: `This turn already made ${MAX_PROPOSALS_PER_TURN} proposals.`,
          };
          stop = true;
          break;
        }

        const startedCall = Date.now();
        let ok = true;
        let result: unknown = null;
        let summary: string;

        try {
          result = await withTimeout(
            invokeTool(context.deps, call.name, args),
            PER_TOOL_TIMEOUT_MS
          );
          summary = summariseResult(call.name, result);
          recordGrounding(ledger, call.name, result);
        } catch (error) {
          ok = false;
          const timedOut = error instanceof TimeoutError;
          summary = timedOut
            ? 'The tool did not answer in ten seconds.'
            : error instanceof Error
              ? error.message
              : 'The tool failed.';
          result = { error: summary };
          if (timedOut) {
            finish = 'limit';
            limitEvent = {
              kind: 'limit',
              seq: next(),
              limit: 'tool_timeout',
              message: summary,
            };
            stop = true;
          }
        }

        const durationMs = Date.now() - startedCall;
        state.toolCalls.push({ callId: call.callId, tool: call.name, summary, ok, durationMs });
        yield {
          kind: 'tool_result',
          seq: next(),
          callId: call.callId,
          tool: call.name,
          ok,
          summary,
          durationMs,
        };

        if (ok && call.name === 'propose_patch') {
          const proposal = result as PatchProposal;
          state.proposals += 1;
          if (proposal.proposal_id !== null && proposal.preview !== null) {
            state.proposalId = proposal.proposal_id;
            yield {
              kind: 'patch_proposed',
              seq: next(),
              proposalId: proposal.proposal_id,
              patchDigest: proposal.patch_digest,
              summary: summary,
              touchedNodeIds: proposal.touched_node_ids,
              preview: proposal.preview,
            };
          }
        }

        messages.push({
          role: 'tool',
          toolCallId: call.callId,
          content: JSON.stringify(result ?? null),
        });

        if (stop) break;
      }

      if (stop) break;
    }
  } catch (error) {
    finish = 'error';
    yield {
      kind: 'error',
      seq: next(),
      code: 'provider_error',
      // The message this process wrote, never a provider response body: one of
      // those can carry the request it rejected, and the request carries the
      // architecture.
      message: error instanceof Error ? error.message : 'The model could not be reached.',
    };
  } finally {
    controller.abort();
  }

  if (limitEvent !== null) yield limitEvent;

  yield {
    kind: 'done',
    seq: next(),
    finish,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    toolCalls: state.toolCalls.length,
    unverifiedCitations: state.unverified,
  };
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return {};
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('The tool failed.'));
      }
    );
  });
}

/**
 * What the model is allowed to cite, taken from what the tools returned rather
 * than from anything the model said.
 */
function recordGrounding(ledger: GroundingLedger, tool: string, result: unknown): void {
  if (typeof result !== 'object' || result === null) return;
  const record = result as Record<string, unknown>;

  for (const citation of (record.evidence ?? []) as { path?: string }[]) {
    if (typeof citation.path === 'string') ledger.recordFile(citation.path);
  }

  const source = record.price_source as { file?: string } | null | undefined;
  if (source?.file !== undefined) ledger.recordSku(source.file);

  const preview = (record.preview ?? (tool === 'price_change' ? record : null)) as {
    patchDigest?: string;
  } | null;
  if (typeof preview?.patchDigest === 'string') ledger.recordPrediction(preview.patchDigest);

  for (const option of (record.options ?? []) as { preview?: { patchDigest?: string } }[]) {
    if (typeof option.preview?.patchDigest === 'string') {
      ledger.recordPrediction(option.preview.patchDigest);
    }
  }
}
