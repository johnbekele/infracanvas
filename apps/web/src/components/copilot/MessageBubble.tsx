import { memo } from 'react';

import { segments } from '@/lib/copilot/render';
import type { CopilotMessage } from '@/lib/copilot/types';
import { CitationChip } from './CitationChip';
import { PatchDiffCard } from './PatchDiffCard';
import { ToolCallRow } from './ToolCallRow';

interface MessageBubbleProps {
  message: CopilotMessage;
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}

function MessageBubbleComponent({ message, onAccept, onReject }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const parts = isUser ? null : segments(message.content, message.citations);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[95%] space-y-2 rounded-lg px-3 py-2 text-xs ${
          isUser
            ? 'bg-violet-600 text-white'
            : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.toolCalls.length > 0 && (
              <div className="space-y-1 border-b border-gray-200 pb-2 dark:border-gray-700">
                {message.toolCalls.map((call) => (
                  <ToolCallRow key={call.callId} call={call} />
                ))}
              </div>
            )}

            {parts && parts.length > 0 && (
              <div className="whitespace-pre-wrap leading-relaxed">
                {parts.map((part, index) => {
                  if (part.kind === 'text') {
                    return <span key={index}>{part.text}</span>;
                  }
                  if (part.kind === 'code') {
                    return (
                      <code
                        key={index}
                        className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10"
                      >
                        {part.text}
                      </code>
                    );
                  }
                  if (part.kind === 'block') {
                    return (
                      <pre
                        key={index}
                        className="my-1 overflow-x-auto rounded bg-black/5 p-2 font-mono text-[11px] dark:bg-black/30"
                      >
                        {part.language ? (
                          <span className="mb-1 block text-[10px] text-gray-500">
                            {part.language}
                          </span>
                        ) : null}
                        {part.text}
                      </pre>
                    );
                  }
                  return (
                    <CitationChip
                      key={index}
                      scheme={part.scheme}
                      target={part.target}
                      verified={part.verified}
                    />
                  );
                })}
              </div>
            )}

            {message.proposal && (
              <PatchDiffCard proposal={message.proposal} onAccept={onAccept} onReject={onReject} />
            )}

            {message.status === 'cancelled' && (
              <p className="text-[10px] italic text-gray-500">Stopped</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(
  MessageBubbleComponent,
  (prev, next) =>
    prev.message === next.message &&
    prev.onAccept === next.onAccept &&
    prev.onReject === next.onReject
);
