import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';

import type { Slice } from '@/components/simulation/charts/StackedBar';
import { Label } from '@/components/ui/blueprint';
import { downtime, duration, moneyExact, percent, rate } from '@/lib/estimate/format';
import { useEstimate } from '@/lib/estimate/use-estimate';
import { categoryOfKind } from '@/lib/simulation/coverage';

/**
 * The running summary beside the canvas: four figures, where the money goes,
 * and how much the models could not account for.
 *
 * It used to be the whole simulation, which put a scrolling wall of tables in a
 * 320px column next to the drawing they described. The detail now lives on its
 * own page; what belongs here is the part a person wants while they are still
 * drawing -- did that change make it cheaper, slower, less available -- with
 * one link to the reasoning.
 */
export function SimulationTab() {
  const { estimate, skipped, error } = useEstimate();

  if (error !== null) {
    return (
      <div className="flex-1 p-3">
        <p className="border-destructive/40 bg-destructive/5 text-destructive border p-2 text-[11px]">
          {error}
        </p>
      </div>
    );
  }

  if (estimate === null) {
    return (
      <div className="flex-1 p-3">
        <p className="text-muted-foreground text-[11px]">
          Nothing on the canvas yet. Drop a service, or open a repository and let the analysis
          propose one, and every figure here follows from it.
        </p>
      </div>
    );
  }

  const availability = estimate.availability.value;
  const first = estimate.bottleneck.value.first;
  const blindSpots =
    estimate.cost.value.unpriced.length +
    availability.unmodelled.length +
    estimate.findings.unchecked.length +
    skipped.length;

  const byCategory = new Map<string, Slice>();
  for (const resource of estimate.cost.value.byResource) {
    if (resource.lines.length === 0) continue;
    const category = categoryOfKind(resource.kind);
    const existing = byCategory.get(category.name);
    if (existing === undefined) {
      byCategory.set(category.name, {
        key: category.name,
        label: category.name,
        value: resource.monthlyUsd,
        colour: category.colour,
      });
    } else {
      existing.value += resource.monthlyUsd;
    }
  }

  const rows = [
    {
      label: 'Availability',
      value: percent(availability.compositeAvailability),
      note: downtime(availability.compositeAvailability),
    },
    {
      label: 'p95 latency',
      value: estimate.latency === null ? '—' : duration(estimate.latency.value.p95Ms),
      note: estimate.latency === null ? 'nothing on the path queues' : 'across every hop',
    },
    {
      label: 'Scale ceiling',
      value: first === null ? 'none found' : rate(first.breakingRps),
      note: first === null ? 'within the swept range' : first.label.toLowerCase(),
    },
    {
      label: 'Findings',
      value: String(estimate.findings.findings.length),
      note: `${estimate.findings.unchecked.length} kinds have no rules`,
    },
  ];

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      <div>
        <Label>Monthly cost</Label>
        <p className="tabular font-heading text-2xl font-semibold leading-tight">
          {moneyExact(estimate.cost.value.monthlyUsd)}
        </p>
        {byCategory.size > 0 && (
          <div className="border-border mt-1.5 flex h-2 w-full overflow-hidden border">
            {[...byCategory.values()].map((slice) => (
              <span
                key={slice.key}
                title={`${slice.label} ${moneyExact(slice.value)}`}
                style={{
                  width: `${(slice.value / estimate.cost.value.monthlyUsd) * 100}%`,
                  background: slice.colour,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-[11px]">{row.label}</dt>
            <dd className="text-right">
              <span className="tabular text-xs font-medium">{row.value}</span>
              <span className="text-muted-foreground block text-[9px]">{row.note}</span>
            </dd>
          </div>
        ))}
      </dl>

      {blindSpots > 0 && (
        <p className="flex items-start gap-1.5 border border-[hsl(var(--ink-warn))]/40 bg-[hsl(var(--ink-warn))]/[0.06] p-2 text-[10px] leading-snug">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {blindSpots} thing{blindSpots === 1 ? '' : 's'} these figures leave out. Each headline
            is a floor over the part that could be modelled.
          </span>
        </p>
      )}

      <Link
        to="/simulation"
        className="border-primary bg-primary text-primary-foreground flex items-center justify-center gap-1.5 border px-2 py-1.5 text-xs font-medium"
      >
        Open the full simulation
        <ArrowUpRight className="h-3 w-3" />
      </Link>

      <p className="text-muted-foreground text-[9px] leading-snug">
        Predicted from the drawing, not measured. The full dashboard shows every rate, quantity and
        assumption behind these figures.
      </p>
    </div>
  );
}
