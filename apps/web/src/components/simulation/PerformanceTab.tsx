import { Figure, Label, Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { duration, rate } from '@/lib/estimate/format';
import type { LoadSweep } from '@/lib/estimate/sweep';

import { LoadChart } from './charts/LoadChart';
import { StackedBar, type Slice } from './charts/StackedBar';

/**
 * How long a request takes, where the time goes, and where the design stops.
 *
 * The percentiles are read off a convolved distribution rather than summed,
 * because percentiles do not add: a path of five hops each with a 10ms p95 does
 * not have a 50ms p95, and a tool that says it does will be wrong in the
 * direction that matters.
 */
export function PerformanceTab({
  estimate,
  sweep,
}: {
  estimate: ArchitectureEstimate;
  sweep: LoadSweep;
}) {
  const latency = estimate.latency;
  const bottleneck = estimate.bottleneck.value;

  if (latency === null) {
    return (
      <Panel>
        <PanelHead title="Nothing to time" />
        <p className="text-muted-foreground text-sm">
          No resource on the request path carries a service time, so there is no queueing network to
          solve. Add a compute or database resource and the model will run.
        </p>
      </Panel>
    );
  }

  const hops: Slice[] = latency.value.contributions
    .map((contribution) => ({
      key: contribution.resourceId,
      label: contribution.resourceId,
      note: `${(contribution.utilisation * 100).toFixed(1)}% busy, ${contribution.servers} server${contribution.servers === 1 ? '' : 's'}`,
      value: contribution.totalMs,
      colour: contribution.saturated
        ? 'hsl(var(--destructive))'
        : `hsl(var(--ink-latency) / ${0.45 + Math.min(contribution.utilisation, 1) * 0.55})`,
    }))
    .sort((a, b) => b.value - a.value);

  const percentiles = [
    { label: 'Mean', value: latency.value.meanMs },
    { label: 'p50', value: latency.value.p50Ms },
    { label: 'p95', value: latency.value.p95Ms },
    { label: 'p99', value: latency.value.p99Ms },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHead title="The distribution" aside={`at ${rate(sweep.baselineRps)}`} />
          <div className="grid grid-cols-4 gap-2">
            {percentiles.map((entry) => (
              <div key={entry.label}>
                <Label>{entry.label}</Label>
                <div className="mt-1">
                  <Figure value={duration(entry.value)} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            Composed by convolving each hop's sojourn distribution, not by adding percentiles. The
            gap between p50 and p99 is queueing: it widens as any hop gets busier, which is what the
            curve below shows.
          </p>
          {latency.value.saturatedAt.length > 0 && (
            <p className="text-destructive mt-2 text-xs">
              {latency.value.saturatedAt.join(', ')} already at or past saturation at this load, so
              these figures are a lower bound.
            </p>
          )}
        </Panel>

        <Panel>
          <PanelHead title="Where the time goes" aside={`${hops.length} hops`} />
          <StackedBar slices={hops} format={duration} />
        </Panel>
      </div>

      <Panel>
        <PanelHead
          title="p95 against load"
          aside={
            sweep.capacityRps === null
              ? 'no ceiling found in range'
              : `capacity ${rate(sweep.capacityRps)}`
          }
        />
        <LoadChart
          rates={sweep.points.map((point) => point.rps)}
          baselineRps={sweep.baselineRps}
          capacityRps={sweep.capacityRps}
          series={{
            label: 'p95 latency',
            hue: 'var(--ink-latency)',
            values: sweep.points.map((point) => point.p95Ms),
            format: duration,
          }}
        />
        <p className="text-muted-foreground mt-2 text-xs">
          Each point is a full re-solve of the queueing network at that rate — not an extrapolation.
          The line stops where a hop reaches capacity: past that the waiting time diverges and any
          number drawn there would be invented.
        </p>
      </Panel>

      <Panel>
        <PanelHead
          title="Where it stops scaling"
          aside={
            bottleneck.first === null
              ? 'nothing breaks in range'
              : `first at ${rate(bottleneck.first.breakingRps)}`
          }
        />

        {bottleneck.ranked.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No limit on this architecture was reached within the range the solver sweeps. That is a
            statement about the limits it knows, not a promise that the design is unbounded.
          </p>
        ) : (
          <ul className="space-y-2">
            {bottleneck.ranked.map((entry) => (
              <li
                key={`${entry.resourceId}-${entry.limitId}`}
                className="border-border/50 border-b pb-2 last:border-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">
                    {entry.label}
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      {entry.resourceId}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-sm">{rate(entry.breakingRps)}</span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <div className="bg-secondary h-1 flex-1">
                    <div
                      className="h-1"
                      style={{
                        width: `${Math.min(entry.usageAtTarget * 100, 100)}%`,
                        background:
                          entry.usageAtTarget > 0.7
                            ? 'hsl(var(--destructive))'
                            : 'hsl(var(--ink-saturation))',
                      }}
                    />
                  </div>
                  <span className="tabular text-muted-foreground shrink-0 text-[10px]">
                    {(entry.usageAtTarget * 100).toFixed(1)}% used
                  </span>
                </div>

                <p className="text-muted-foreground mt-1 text-[11px]">
                  {entry.remedy}{' '}
                  <span className={entry.adjustable ? 'text-foreground' : ''}>
                    {entry.adjustable
                      ? 'This is an adjustable quota — a support request raises it.'
                      : 'This is a hard limit; only a design change moves it.'}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
