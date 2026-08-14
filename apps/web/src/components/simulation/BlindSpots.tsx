import { AlertTriangle } from 'lucide-react';

import { Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { serviceNameOfKind } from '@/lib/simulation/coverage';

/**
 * Everything the four models could not account for, gathered in one place.
 *
 * This is the panel that makes the rest of the page usable. A cost that does
 * not name what it left out reads as a complete cost; an availability figure
 * that quietly drops the resources it had no SLA for reads as the availability
 * of the whole system. Naming the gaps turns each headline into what it
 * honestly is -- a floor, over the part that could be modelled.
 *
 * It is loud by design. If it is empty that is worth seeing too.
 */
export function BlindSpots({
  estimate,
  skipped,
}: {
  estimate: ArchitectureEstimate;
  skipped: readonly { id: string; name: string; reason: string }[];
}) {
  const groups = [
    { title: 'Not in the cost', entries: estimate.cost.value.unpriced },
    { title: 'Not in the availability', entries: estimate.availability.value.unmodelled },
    {
      title: 'No Well-Architected rule exists',
      entries: estimate.findings.unchecked.map(serviceNameOfKind),
    },
    {
      title: 'Not on the canvas the models read',
      entries: skipped.map((node) => `${node.name} — ${node.reason}`),
    },
  ].filter((group) => group.entries.length > 0);

  if (groups.length === 0) {
    return (
      <Panel>
        <PanelHead title="Blind spots" aside="None" />
        <p className="text-muted-foreground text-xs">
          Every resource on the canvas was priced, given an availability, and checked against the
          rules that exist. The figures on this page cover the whole design.
        </p>
      </Panel>
    );
  }

  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <Panel tone="warn">
      <PanelHead
        title="Not included in these figures"
        aside={`${total} item${total === 1 ? '' : 's'}`}
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
      />
      <p className="text-muted-foreground mb-3 text-xs">
        Each headline is a floor over the part that could be modelled. These are the parts that
        could not be.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="text-[11px] font-medium">{group.title}</p>
            <ul className="text-muted-foreground mt-1 space-y-0.5 text-[11px]">
              {group.entries.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}
