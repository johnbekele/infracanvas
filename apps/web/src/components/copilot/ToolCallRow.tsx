import { Loader2, Check, X } from 'lucide-react';

import { describeToolCall } from '@/lib/copilot/tool-labels';
import type { ToolCallView } from '@/lib/copilot/types';

interface ToolCallRowProps {
  call: ToolCallView;
}

export function ToolCallRow({ call }: ToolCallRowProps) {
  const pending = call.ok === undefined;
  return (
    <div className="flex items-start gap-2 text-[11px] text-gray-600 dark:text-gray-300">
      {pending ? (
        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-violet-500" />
      ) : call.ok ? (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <X className="mt-0.5 h-3 w-3 shrink-0 text-rose-500" />
      )}
      <span>{describeToolCall(call)}</span>
    </div>
  );
}
