import { Figure, Label, Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { downtime, duration, percent } from '@/lib/estimate/format';
import { PILLAR_NAMES } from '@/lib/simulation/coverage';

/**
 * What the design's availability is composed of, what to promise on the back of
 * it, and where it departs from the framework.
 *
 * Availability multiplies along a series path, so the composite is always below
 * its weakest member and every hop added lowers it. Showing the composition
 * rather than only the total is what makes that arithmetic arguable: the reader
 * can see which single resource to make redundant to move the figure.
 */
export function ReliabilityTab({ estimate }: { estimate: ArchitectureEstimate }) {
  const report = estimate.availability.value;
  const findings = estimate.findings.byPillar.reliability;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Panel>
          <PanelHead title="Composed availability" />
          <Figure value={percent(report.compositeAvailability)} />
          <p className="text-muted-foreground mt-2 text-xs">
            That allows {downtime(report.compositeAvailability)}, or{' '}
            {report.downtimeMinutesPerMonth.toFixed(0)} minutes.
          </p>
          <p className="text-muted-foreground mt-3 text-xs">
            Resources on the request path are multiplied together, because a request needs all of
            them. Redundant members are combined in parallel first, which is why a multi-AZ
            deployment lifts the figure rather than lowering it.
          </p>
        </Panel>

        <Panel>
          <PanelHead title="What it is made of" aside={`${report.nodes.length} in series`} />
          {report.nodes.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nothing on this canvas serves requests, so there is no composition to show.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...report.nodes]
                .sort((a, b) => a.availability - b.availability)
                .map((node) => (
                  <li key={node.resourceId}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="truncate">
                        {node.resourceId}
                        {node.resourceId === report.weakest && (
                          <span className="border-destructive/50 text-destructive ml-2 border px-1 text-[9px] uppercase tracking-wide">
                            weakest link
                          </span>
                        )}
                      </span>
                      <span className="tabular shrink-0">{percent(node.availability)}</span>
                    </div>
                    <div className="bg-secondary mt-0.5 h-1 w-full">
                      <div
                        className="h-1"
                        style={{
                          // Against the last three nines, since every figure here
                          // is above 99% and a 0-100% bar would show four
                          // identical full bars.
                          width: `${Math.max(0, Math.min(1, (node.availability - 0.99) / 0.0099)) * 100}%`,
                          background:
                            node.resourceId === report.weakest
                              ? 'hsl(var(--destructive))'
                              : 'hsl(var(--ink-availability))',
                        }}
                      />
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-[10px]">
                      {node.configuration} · {node.azCount} AZ{node.azCount === 1 ? '' : 's'} ·{' '}
                      {node.basis === 'published'
                        ? 'from the published SLA'
                        : 'modelled, no SLA covers this configuration exactly'}
                    </p>
                  </li>
                ))}
            </ul>
          )}

          {report.unmodelled.length > 0 && (
            <p className="border-border text-muted-foreground mt-3 border-t pt-2 text-[11px]">
              Left out because no SLA and no model covers them: {report.unmodelled.join(', ')}. The
              composite above is therefore an upper bound.
            </p>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHead
          title="Objectives worth promising"
          aside={`${estimate.slos.value.length} proposed`}
        />
        {estimate.slos.value.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Too little of this architecture could be modelled to stand behind an objective.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {estimate.slos.value.map((slo) => (
              <div key={`${slo.objective}-${slo.target}`} className="border-border border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Label>{slo.objective === 'availability' ? 'Availability' : 'Latency'} SLO</Label>
                  <span className="text-muted-foreground text-[10px]">{slo.window} window</span>
                </div>
                <div className="mt-1">
                  <Figure
                    value={slo.unit === 'fraction' ? percent(slo.target) : duration(slo.target)}
                  />
                </div>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Error budget: {slo.errorBudgetMinutes.toFixed(0)} minutes over the window.
                </p>
                <p className="mt-2 text-[11px]">{slo.rationale}</p>

                <div className="border-border mt-2 border-t pt-2">
                  <Label>How to measure it</Label>
                  <p className="text-muted-foreground mt-1 text-[11px]">{slo.sli.description}</p>
                  <pre className="bg-secondary mt-1 overflow-x-auto whitespace-pre-wrap break-all p-2 text-[10px] leading-relaxed">
                    {slo.sli.goodEvents}
                    {'\n\u00f7 '}
                    {slo.sli.totalEvents}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHead
          title="Reliability findings"
          aside={findings.length === 0 ? 'none raised' : `${findings.length} raised`}
        />
        {findings.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No reliability rule fired. Rules exist for a small set of resource kinds, so this means
            the rules that ran found nothing — not that the architecture was fully reviewed.
          </p>
        ) : (
          <ul className="space-y-3">
            {findings.map((finding) => (
              <li key={finding.ruleId} className="border-destructive/60 border-l-2 pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium">{finding.message}</span>
                  <span className="text-muted-foreground shrink-0 text-[9px] uppercase tracking-wide">
                    {finding.severity} · {PILLAR_NAMES[finding.pillar]}
                  </span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-[11px]">{finding.remediation}</p>
                <p className="text-muted-foreground mt-0.5 text-[10px]">
                  {finding.ruleId} at <code>{finding.pointer}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
