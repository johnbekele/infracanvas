import { useEffect, useRef, useState } from 'react';

import { useCopilotStore } from '@/lib/stores/copilot-store';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}

export function MessageList({ onAccept, onReject }: MessageListProps) {
  const messages = useCopilotStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, stickToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distance < 48);
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.length === 0 && (
        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
          Ask how to change the architecture. Proposed edits appear as cards you can accept or
          reject.
        </p>
      )}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onAccept={onAccept} onReject={onReject} />
      ))}
    </div>
  );
}
