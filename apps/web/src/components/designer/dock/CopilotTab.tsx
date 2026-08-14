import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUp, Check, Loader2, Square, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useConversation } from '@/lib/copilot/use-conversation';

import { PatchProposalCard } from './PatchProposalCard';
import type { AcceptedPatch } from '@/lib/copilot/api';
import type { Turn, ToolCall } from '@/lib/copilot/conversation';

/**
 * The copilot, in conversation about the architecture on the canvas.
 *
 * It does not answer with prose alone. Every edit it wants to make arrives as a
 * proposal card with the change in cost and availability already computed, and
 * nothing is applied until the user says so. That is the difference between an
 * assistant that suggests and one that acts: the model proposes typed patches,
 * the platform prices them, and the person decides.
 *
 * Tool calls are shown as they run rather than hidden. A number produced by a
 * priced model and a number a model made up are indistinguishable in prose, and
 * seeing which tool produced the figure is how a reader tells them apart.
 */
/**
 * Refusals a model key fixes. Kept as a set rather than an equality check
 * because the one that was compared against here before, `no_credential`, is
 * not a code the server sends, so the sentence explaining the fix never showed.
 */
const NO_KEY_CODES = new Set(['no_llm_credential', 'unsupported_provider']);

export function CopilotTab({
  experimentId,
  onStart,
  isStarting = false,
  startError = null,
  skipped = [],
  onApplied,
}: {
  experimentId: string | null;
  /**
   * Turns the drawing into an experiment, on a page that has no experiment yet.
   * Absent when the page is already showing one.
   */
  onStart?: () => Promise<string | null>;
  isStarting?: boolean;
  startError?: string | null;
  /** Canvas nodes the architecture document cannot represent, named so the user knows. */
  skipped?: string[];
  onApplied?: (applied: AcceptedPatch) => void;
}) {
  const { turns, isStreaming, refusal, send, stop, accept, reject } = useConversation(experimentId);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  /**
   * A message typed before there is an experiment starts one and is then sent.
   *
   * The alternative is a disabled box with an explanation of why the user has
   * to press something else first, which is a rule about our data model dressed
   * up as an instruction. Typing is the intent; making the experiment is
   * bookkeeping the platform can do on the way.
   */
  useEffect(() => {
    if (pending === null || experimentId === null) return;
    send(pending);
    setPending(null);
  }, [pending, experimentId, send]);

  if (experimentId === null && onStart === undefined) {
    return (
      <div className="flex-1 p-3">
        <p className="text-[11px] text-gray-500">
          The copilot works on an experiment: an architecture with a history, so a change can be
          proposed against a known document and undone. Open a repository and start one, and this is
          where you argue with what it proposed.
        </p>
      </div>
    );
  }

  const submit = () => {
    const message = draft.trim();
    if (message === '' || isStreaming || isStarting) return;
    setDraft('');

    if (experimentId === null) {
      void onStart?.().then((started) => {
        if (started === null) return;
        setPending(message);
      });
      return;
    }

    send(message);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {turns.length === 0 && (
          <p className="text-[11px] text-gray-500">
            Ask for what you want rather than for a service. &ldquo;Spend less, I can take slower
            reads&rdquo; and &ldquo;this has to survive a zone failure&rdquo; are the kinds of things
            it can price and act on. It answers with a change to the canvas, costed, for you to
            accept or throw away.
          </p>
        )}

        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            onAccept={async (proposalId) => {
              const applied = await accept(proposalId);
              if (applied !== null) onApplied?.(applied);
            }}
            onReject={reject}
          />
        ))}

        {skipped.length > 0 && (
          <p className="text-[10px] text-gray-500">
            Reasoning about everything on the canvas except {skipped.join(', ')}, which the
            architecture document has no representation for yet. Nothing it says accounts for those.
          </p>
        )}

        {startError !== null && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {startError}
          </p>
        )}

        {refusal !== null && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="flex items-start gap-1.5 text-[11px] text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {refusal.message}
            </p>
            {NO_KEY_CODES.has(refusal.code) && (
              <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-300">
                The copilot spends your key rather than a shared one, so nothing runs until there is
                one to spend.{' '}
                <Link to="/settings" className="font-medium underline">
                  Add a model key
                </Link>
                .
              </p>
            )}
          </div>
        )}

        <div ref={bottom} />
      </div>

      <div className="shrink-0 border-t border-gray-200 p-2 dark:border-gray-800">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            rows={2}
            placeholder="Ask for a change, or for the reasoning behind one"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none placeholder:text-gray-400 focus:border-violet-400 dark:border-gray-700 dark:bg-gray-800"
          />
          {isStreaming ? (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={stop} title="Stop">
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-8 w-8"
              disabled={draft.trim() === '' || isStarting}
              onClick={submit}
              title="Send"
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  onAccept,
  onReject,
}: {
  turn: Turn;
  onAccept: (proposalId: string) => Promise<void>;
  onReject: (proposalId: string) => Promise<void>;
}) {
  if (turn.role === 'user') {
    return (
      <p className="ml-6 rounded-lg bg-gray-100 px-2.5 py-1.5 text-[11px] text-gray-800 dark:bg-gray-800 dark:text-gray-200">
        {turn.content}
      </p>
    );
  }

  const proposal = turn.proposal;

  return (
    <div className="space-y-1.5">
      {turn.toolCalls.map((call) => (
        <ToolCallLine key={call.callId} call={call} />
      ))}

      {turn.content !== '' && (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-gray-800 dark:text-gray-200">
          {turn.content}
        </p>
      )}

      {turn.status === 'streaming' && turn.content === '' && turn.toolCalls.length === 0 && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
      )}

      {proposal !== null && (
        <PatchProposalCard
          proposal={proposal}
          onAccept={() => onAccept(proposal.proposalId)}
          onReject={() => onReject(proposal.proposalId)}
        />
      )}

      {turn.unverifiedCitations > 0 && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          {turn.unverifiedCitations} citation{turn.unverifiedCitations === 1 ? '' : 's'} could not be
          checked against the evidence this run collected. Treat those claims as unsourced.
        </p>
      )}

      {turn.note !== null && (
        <p className="text-[10px] text-gray-500">{turn.note}</p>
      )}
    </div>
  );
}

function ToolCallLine({ call }: { call: ToolCall }) {
  return (
    <p className="flex items-center gap-1.5 text-[10px] text-gray-500">
      {call.ok === null ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : call.ok ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <AlertTriangle className="h-3 w-3 text-amber-600" />
      )}
      <Wrench className="h-2.5 w-2.5" />
      <span className="font-mono">{call.tool}</span>
      <span className="truncate">{call.summary}</span>
    </p>
  );
}

