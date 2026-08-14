import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, SlidersHorizontal } from 'lucide-react';

import { AppHeader } from '@/components/layout/AppHeader';
import { AssumptionEditor } from '@/components/simulation/AssumptionEditor';
import { CostTab } from '@/components/simulation/CostTab';
import { OverviewTab } from '@/components/simulation/OverviewTab';
import { PerformanceTab } from '@/components/simulation/PerformanceTab';
import { ReliabilityTab } from '@/components/simulation/ReliabilityTab';
import { Panel } from '@/components/ui/blueprint';
import { useEstimate } from '@/lib/estimate/use-estimate';
import { loadSweep } from '@/lib/estimate/sweep';
import { cn } from '@/lib/utils';

/**
 * The whole simulation, on its own page.
 *
 * It reads the same persisted canvas store the dock reads, so there is no new
 * endpoint and no experiment to bind: a drawing and an analysed repository both
 * arrive here through the canvas, and whatever the dock is quoting, this page
 * is quoting too.
 *
 * Every figure on it is predicted from the document. Nothing here has been
 * measured, and the page says so in the one place a reader would otherwise
 * assume otherwise -- the blind-spot panel, which names what each total left
 * out so that the headline reads as the floor it is.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cost', label: 'Cost' },
  { id: 'performance', label: 'Performance' },
  { id: 'reliability', label: 'Reliability' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SimulationPage() {
  const [tab, setTab] = useState<TabId>('overview');
  const [showAssumptions, setShowAssumptions] = useState(false);

  const { estimate, document, assumptions, skipped, error, overrideAssumption, resetAssumptions } =
    useEstimate();

  // The path the availability model reasoned about is the one the sweep follows,
  // so a curve and a headline never describe two different routes.
  const path = useMemo(
    () => estimate?.availability.value.nodes.map((node) => node.resourceId) ?? [],
    [estimate]
  );

  const sweep = useMemo(
    () => (estimate === null ? null : loadSweep(document, path, assumptions)),
    [estimate, document, path, assumptions]
  );

  const blindSpots =
    estimate === null
      ? 0
      : estimate.cost.value.unpriced.length +
        estimate.availability.value.unmodelled.length +
        estimate.findings.unchecked.length +
        skipped.length;

  return (
    <div className="bg-background flex h-screen flex-col">
      <AppHeader />

      <div className="border-border bg-card flex items-center justify-between gap-4 border-b px-4 py-2">
        <div className="flex items-baseline gap-3">
          <Link
            to="/designer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            <ArrowLeft className="h-3 w-3" />
            Canvas
          </Link>
          <h1 className="font-heading text-lg font-semibold uppercase tracking-wide">Simulation</h1>
          <span className="tabular text-muted-foreground text-xs">
            {document.region} · {document.nodes.length} modelled
            {blindSpots > 0 && ` · ${blindSpots} blind spot${blindSpots === 1 ? '' : 's'}`}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowAssumptions((open) => !open)}
          className={cn(
            'flex items-center gap-1.5 border px-2 py-1 text-xs transition-colors',
            showAssumptions
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border hover:bg-secondary'
          )}
        >
          <SlidersHorizontal className="h-3 w-3" />
          Assumptions
        </button>
      </div>

      <nav className="border-border bg-card flex shrink-0 gap-1 border-b px-4">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === entry.id
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-4">
          {error !== null && (
            <Panel tone="warn" className="mb-4">
              <p className="text-sm">{error}</p>
            </Panel>
          )}

          {estimate === null && error === null && <EmptyCanvas />}

          {estimate !== null && sweep !== null && (
            <>
              {tab === 'overview' && (
                <OverviewTab
                  estimate={estimate}
                  document={document}
                  sweep={sweep}
                  skipped={skipped}
                />
              )}
              {tab === 'cost' && <CostTab estimate={estimate} sweep={sweep} />}
              {tab === 'performance' && <PerformanceTab estimate={estimate} sweep={sweep} />}
              {tab === 'reliability' && <ReliabilityTab estimate={estimate} />}
            </>
          )}
        </main>

        {showAssumptions && estimate !== null && (
          <aside className="border-border bg-card w-72 shrink-0 overflow-y-auto border-l p-3">
            <AssumptionEditor
              assumptions={estimate.assumptions}
              onChange={overrideAssumption}
              onReset={resetAssumptions}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

function EmptyCanvas() {
  return (
    <Panel className="mx-auto mt-12 max-w-lg">
      <h2 className="font-heading text-lg font-semibold uppercase">Nothing to simulate yet</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Every figure on this page follows from an architecture. Draw one on the canvas, or connect a
        repository and let the analysis propose one, and the four models will run over it.
      </p>
      <Link
        to="/designer"
        className="border-primary bg-primary text-primary-foreground mt-4 inline-block border px-3 py-1.5 text-sm font-medium"
      >
        Open the canvas
      </Link>
    </Panel>
  );
}
