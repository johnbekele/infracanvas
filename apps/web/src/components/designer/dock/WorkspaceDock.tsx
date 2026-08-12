import { useEffect, useState } from 'react';
import { ChevronRight, Code2, Gauge, Settings2, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useDesignerStore } from '@/lib/stores/designer-store';

import { CodeTab } from './CodeTab';
import { CopilotTab } from './CopilotTab';
import { PropertiesTab } from './PropertiesTab';
import { SimulationTab } from './SimulationTab';

type DockTab = 'simulation' | 'copilot' | 'properties' | 'code';

const TABS: { id: DockTab; label: string; icon: typeof Gauge }[] = [
  { id: 'simulation', label: 'Simulation', icon: Gauge },
  { id: 'copilot', label: 'Copilot', icon: Sparkles },
  { id: 'properties', label: 'Properties', icon: Settings2 },
  { id: 'code', label: 'Code', icon: Code2 },
];

/**
 * One dock down the right of the canvas, holding the three things a user reads
 * about the architecture they are drawing.
 *
 * Previously each of these was its own panel: properties slid in from the right,
 * the estimate slid in beside it, and the generated code took a slice off the
 * bottom of the canvas. Opening two at once left the canvas a column in the
 * middle, and the code was permanently in the way of the drawing it described.
 * Tabs cost one click to switch and give each surface the full height, which is
 * what a cost breakdown and a Terraform file both need.
 *
 * Selecting a node switches to Properties, because clicking a node is the
 * question "what is this", and the dock should answer the question that was
 * asked rather than wait to be told twice.
 */
export function WorkspaceDock({
  isMobile = false,
  experimentId = null,
}: {
  isMobile?: boolean;
  /** The experiment the copilot converses about. Null until one has been started. */
  experimentId?: string | null;
}) {
  const [tab, setTab] = useState<DockTab>('simulation');
  const [isOpen, setOpen] = useState(!isMobile);
  const selectedNodeId = useDesignerStore((state) => state.selectedNodeId);

  useEffect(() => {
    if (selectedNodeId === null) return;
    setTab('properties');
    setOpen(true);
  }, [selectedNodeId]);

  if (!isOpen) {
    return (
      <div className="absolute right-3 top-3 z-20 flex flex-col gap-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => {
              setTab(id);
              setOpen(true);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-sm hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:hover:text-white"
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <aside
      className={`flex flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${
        isMobile ? 'fixed inset-y-0 right-0 z-50 w-[92vw] max-w-[360px] shadow-2xl' : 'h-full w-96'
      }`}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 pl-1 pr-2 dark:border-gray-800">
        <nav className="flex">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id}
              className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-xs transition-colors ${
                tab === id
                  ? 'border-violet-500 font-medium text-gray-900 dark:text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)}>
          {isMobile ? <X className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
      </header>

      {tab === 'simulation' && <SimulationTab />}
      {tab === 'copilot' && <CopilotTab experimentId={experimentId} />}
      {tab === 'properties' && <PropertiesTab />}
      {tab === 'code' && <CodeTab />}
    </aside>
  );
}
