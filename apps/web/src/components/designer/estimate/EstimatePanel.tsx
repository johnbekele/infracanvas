import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Calculator, ChevronRight, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useEstimate } from '@/lib/estimate/use-estimate';

import { AssumptionEditor } from './AssumptionEditor';
import { AvailabilitySummary } from './AvailabilitySummary';
import { BottleneckSummary } from './BottleneckSummary';
import { CostBreakdown } from './CostBreakdown';
import { FindingsList } from './FindingsList';
import { LatencySummary } from './LatencySummary';
import { SloProposals } from './SloProposals';

/**
 * What the architecture on the canvas would cost, how available it would be,
 * what objectives it could carry, and where it departs from the Well-Architected
 * Framework - with every assumption behind those figures as an editable input.
 *
 * The panel shows its working on purpose. A tool that answers "$412 a month"
 * and stops is asking to be trusted; one that names the rate, the quantity, the
 * assumption the quantity came from and the things it could not price is asking
 * to be checked, which is the only basis on which anyone should act on it.
 */
export function EstimatePanel({ isMobile = false }: { isMobile?: boolean }) {
  const [isOpen, setOpen] = useState(false);
  const { estimate, skipped, error, overrideAssumption, resetAssumptions } = useEstimate();

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 z-20 flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-2 text-xs font-medium text-white shadow-lg dark:bg-white dark:text-gray-900"
      >
        <Calculator className="h-3.5 w-3.5" />
        Estimate
      </button>
    );
  }

  return (
    <AnimatePresence>
      <motion.aside
        initial={{ x: 320, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 320, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={`flex flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${
          isMobile
            ? 'fixed inset-y-0 right-0 z-50 w-[92vw] max-w-[340px] shadow-2xl'
            : 'h-full w-80'
        }`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-gray-200 p-3 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Estimate</h3>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)}>
            {isMobile ? <X className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          {error !== null && (
            <p className="rounded-md bg-rose-50 p-2 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}

          {estimate !== null && (
            <>
              <CostBreakdown cost={estimate.cost} />
              <AvailabilitySummary report={estimate.availability} />
              <LatencySummary latency={estimate.latency} />
              <BottleneckSummary report={estimate.bottleneck} />
              <SloProposals slos={estimate.slos} />
              <FindingsList findings={estimate.findings} />

              {skipped.length > 0 && (
                <section>
                  <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Left out of every figure
                  </h4>
                  <ul className="mt-1 space-y-0.5 text-[10px] text-gray-500">
                    {skipped.map((node) => (
                      <li key={node.id}>
                        {node.name} {node.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
                <AssumptionEditor
                  assumptions={estimate.assumptions}
                  onChange={overrideAssumption}
                  onReset={resetAssumptions}
                />
              </div>
            </>
          )}
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}
