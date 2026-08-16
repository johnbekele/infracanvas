import { useState, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface CopilotComposerProps {
  disabled: boolean;
  isStreaming: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
}

export function CopilotComposer({ disabled, isStreaming, onSend, onStop }: CopilotComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setValue('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || isStreaming}
          placeholder={
            disabled ? 'Configure a model credential to chat' : 'Ask about this architecture…'
          }
          className="min-h-[64px] resize-none text-xs"
          rows={3}
        />
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-9 w-9 shrink-0"
            onClick={onStop}
            aria-label="Stop"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            aria-label="Send"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <p className="mt-1 text-[10px] text-gray-400">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}
