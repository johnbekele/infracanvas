import { Fragment } from 'react';

import { Figure, Label, Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { moneyExact, quantity, rate } from '@/lib/estimate/format';
import type { LoadSweep } from '@/lib/estimate/sweep';
import { categoryOfKind, serviceNameOfKind } from '@/lib/simulation/coverage';

import { LoadChart } from './charts/LoadChart';
import { StackedBar, type Slice } from './charts/StackedBar';

/**
 * The total, then how it divides, then every line behind it.
 *
 * The line table is the point of the tab. A tool that answers "$412 a month" is
 * asking to be trusted; one that shows the rate, the quantity, the unit and the
 * assumption the quantity came from is asking to be checked -- and being
 * checkable is the only reason anyone should act on a predicted bill.
 */
export function CostTab({ estimate, sweep }: { estimate: ArchitectureEstimate; sweep: LoadSweep }) {
  const cost = estimate.cost.value;
  const priced = cost.byResource.filter((resource) => resource.lines.length > 0);
  const source = priced[0]?.priceSource;
  const byName = new Map(estimate.assumptions.map((entry) => [entry.id, entry]));

  const byCategory = new Map<string, Slice>();
  for (const resource of priced) {
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

  const services = [...priced]
    .sort((a, b) => b.monthlyUsd - a.monthlyUsd)
    .map((resource) => ({
      key: resource.resourceId,
      label: resource.resourceId,
      note: serviceNameOfKind(resource.kind),
      value: resource.monthlyUsd,
      colour: categoryOfKind(resource.kind).colour,
    }));

  const scales = sweep.points[sweep.points.length - 1]?.monthlyUsd !== sweep.points[0]?.monthlyUsd;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
        <Panel>
          <PanelHead title="Monthly total" />
          <Figure value={moneyExact(cost.monthlyUsd)} />
          <p className="text-muted-foreground mt-2 text-xs">
            Predicted, on-demand, before tax and before any discount. Reserved capacity, savings
            plans and enterprise agreements all move it downward.
          </p>
          {source && (
            <p className="border-border text-muted-foreground mt-3 border-t pt-2 text-[10px]">
              Prices from AWS price list {source.priceListVersion}, published{' '}
              {source.capturedAt.slice(0, 10)}.
            </p>
          )}
        </Panel>

        <Panel>
          <PanelHead title="By category" aside={`${byCategory.size} of 9`} />
          <StackedBar slices={[...byCategory.values()]} format={moneyExact} />
        </Panel>

        <Panel>
          <PanelHead title="By resource" aside={`${services.length} priced`} />
          <StackedBar slices={services} format={moneyExact} />
        </Panel>
      </div>

      <Panel>
        <PanelHead
          title="Cost against load"
          aside={
            scales ? 'Some lines are billed per request' : 'Nothing here is billed per request'
          }
        />
        {scales ? (
          <LoadChart
            rates={sweep.points.map((point) => point.rps)}
            baselineRps={sweep.baselineRps}
            capacityRps={sweep.capacityRps}
            series={{
              label: 'Monthly cost',
              hue: 'var(--ink-cost)',
              values: sweep.points.map((point) => point.monthlyUsd),
              format: moneyExact,
            }}
          />
        ) : (
          <p className="text-muted-foreground text-xs">
            This total does not move with traffic: every line on it is an hourly or provisioned
            charge. Going from {rate(sweep.baselineRps)} to{' '}
            {rate(sweep.points[sweep.points.length - 1]?.rps ?? sweep.baselineRps)} changes nothing
            on the bill — it changes latency instead, which is on the performance tab.
          </p>
        )}
      </Panel>

      <Panel>
        <PanelHead title="Every line" aside={`${lineCount(priced)} lines`} />
        <table className="w-full text-xs">
          <thead>
            <tr className="border-border border-b text-left">
              <th className="pb-1 font-medium">
                <Label>Line</Label>
              </th>
              <th className="pb-1 font-medium">
                <Label>Quantity</Label>
              </th>
              <th className="pb-1 font-medium">
                <Label>Rate</Label>
              </th>
              <th className="pb-1 font-medium">
                <Label>Moves with</Label>
              </th>
              <th className="pb-1 text-right font-medium">
                <Label>Monthly</Label>
              </th>
            </tr>
          </thead>
          <tbody>
            {priced.map((resource) => (
              <Fragment key={resource.resourceId}>
                <tr>
                  <td colSpan={5} className="pt-3 text-[11px] font-medium">
                    {resource.resourceId}
                    <span className="text-muted-foreground ml-2 font-normal">
                      {serviceNameOfKind(resource.kind)}
                    </span>
                  </td>
                </tr>
                {resource.lines.map((line) => (
                  <tr
                    key={`${resource.resourceId}-${line.label}`}
                    className="border-border/50 border-b align-top"
                  >
                    <td className="text-muted-foreground py-1 pr-3">{line.label}</td>
                    <td className="tabular py-1 pr-3">{quantity(line.quantity, line.unit)}</td>
                    <td className="tabular text-muted-foreground py-1 pr-3">
                      ${line.unitPriceUsd} / {line.unit}
                    </td>
                    <td className="text-muted-foreground py-1 pr-3 text-[10px]">
                      {line.assumptionIds.length === 0
                        ? 'nothing — fixed rate'
                        : line.assumptionIds.map((id) => byName.get(id)?.label ?? id).join(', ')}
                    </td>
                    <td className="tabular py-1 text-right font-medium">
                      {moneyExact(line.monthlyUsd)}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>

        {priced.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Nothing on this canvas has a price yet. Cost contracts exist for a small set of
            resources; the rest are listed as blind spots on the overview.
          </p>
        )}
      </Panel>
    </div>
  );
}

function lineCount(resources: ArchitectureEstimate['cost']['value']['byResource']): number {
  return resources.reduce((sum, resource) => sum + resource.lines.length, 0);
}
