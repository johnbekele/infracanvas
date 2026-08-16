import { MessageSquare, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useCopilot } from '@/lib/hooks/use-copilot';
import { useCopilotStore } from '@/lib/stores/copilot-store';
import { useDesignerStore } from '@/lib/stores/designer-store';
import { CopilotComposer } from './CopilotComposer';
import { MessageList } from './MessageList';
import { NotConfiguredCard } from './NotConfiguredCard';

interface CopilotPanelProps {
  isMobile?: boolean;
}

export function CopilotPanel({ isMobile = false }: CopilotPanelProps) {
  const [params] = useSearchParams();
  const designId = useDesignerStore((s) => s.designId);
  const experimentId = params.get('experiment') ?? designId;
  const close = useCopilotStore((s) => s.close);
  const refusal = useCopilotStore((s) => s.refusal);
  const { isStreaming, send, stop, accept, reject } = useCopilot(experimentId);

  const notConfigured = refusal?.code === 'no_llm_credential';

  return (
    <aside
      className={`flex flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${
        isMobile
          ? 'fixed inset-y-0 right-0 z-50 w-[92vw] max-w-[360px] shadow-2xl'
          : 'h-1/2 min-h-[240px] w-80 shrink-0'
      }`}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-violet-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Copilot</h3>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </header>

      {notConfigured && (
        <NotConfiguredCard
          message={
            refusal?.message ??
            'No model credential is configured. Add one in settings to use the copilot.'
          }
        />
      )}

      {!experimentId && (
        <p className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">
          Open an experiment to start a conversation about its architecture.
        </p>
      )}

      <MessageList onAccept={accept} onReject={reject} />

      <CopilotComposer
        disabled={notConfigured || !experimentId}
        isStreaming={isStreaming}
        onSend={send}
        onStop={stop}
      />
    </aside>
  );
}
