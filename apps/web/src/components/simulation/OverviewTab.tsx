import type { ArchitectureIr } from '@infracanvas/core';

import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { downtime, duration, moneyExact, percent, rate } from '@/lib/estimate/format';
import type { LoadSweep } from '@/lib/estimate/sweep';

import { BlindSpots } from './BlindSpots';
import { HeroTile } from './HeroTile';
import { PillarCoverage } from './PillarCoverage';
import { ServiceMap } from './ServiceMap';

/**
 * The four answers, then everything that qualifies them.
 *
 * Order is deliberate: figures first because that is what the reader came for,
 * blind spots immediately after because a headline read without them is read
 * wrongly, and the path last because it explains where the first two came from.
 */
export function OverviewTab({
  estimate,
  document,
  sweep,
  skipped,
}: {
  estimate: ArchitectureEstimate;
  document: ArchitectureIr;
  sweep: LoadSweep;
  skipped: readonly { id: string; name: string; reason: string }[];
}) {
  const costs = sweep.points.map((point) => point.monthlyUsd);
  const latencies = sweep.points.map((point) => point.p95Ms);
  const utilisations = sweep.points.map((point) => point.peakUtilisation);
  const availability = estimate.availability.value;
  const first = estimate.bottleneck.value.first;

  // The baseline is the first sample by construction, so the marker on every
  // curve is the point the headline figure was taken at.
  const marker = 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <HeroTile
          label="Monthly cost"
          value={moneyExact(estimate.cost.value.monthlyUsd)}
          caption="On-demand, before tax and before any discount."
          hue="var(--ink-cost)"
          values={costs}
          markerIndex={marker}
          footer={
            costs[costs.length - 1] === costs[0]
              ? 'Flat with load: nothing here is billed per request.'
              : `${moneyExact(costs[costs.length - 1]!)} at the top of the sweep.`
          }
        />

        <HeroTile
          label="Availability"
          value={percent(availability.compositeAvailability)}
          caption={`Composed along the path. That allows ${downtime(availability.compositeAvailability)}.`}
          hue="var(--ink-availability)"
          footer={
            availability.weakest === '' ? undefined : `Weakest link: ${availability.weakest}.`
          }
        />

        <HeroTile
          label="p95 latency"
          value={estimate.latency === null ? '—' : duration(estimate.latency.value.p95Ms)}
          caption={
            estimate.latency === null
              ? 'Nothing on the path carries a service time to queue on.'
              : 'Queueing across every hop, at the assumed load.'
          }
          hue="var(--ink-latency)"
          values={latencies}
          markerIndex={marker}
          footer={
            sweep.capacityRps === null
              ? undefined
              : `Rises to ${duration(lastMeasured(latencies) ?? 0)} before the path saturates.`
          }
        />

        <HeroTile
          label="Scale ceiling"
          value={first === null ? 'None found' : rate(first.breakingRps)}
          caption={
            first === null
              ? 'No limit was reached within the range the solver sweeps.'
              : `${first.resourceId} runs out first: ${lowerFirst(first.label)}.`
          }
          hue="var(--ink-saturation)"
          values={utilisations}
          markerIndex={marker}
          footer={
            first === null
              ? undefined
              : `${(first.usageAtTarget * 100).toFixed(1)}% of it in use at the assumed load.`
          }
        />
      </div>

      <BlindSpots estimate={estimate} skipped={skipped} />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <ServiceMap estimate={estimate} document={document} />
        <PillarCoverage findings={estimate.findings} />
      </div>
    </div>
  );
}

/** Limit labels are written as standalone sentences; here one is a clause. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function lastMeasured(values: readonly (number | null)[]): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}
