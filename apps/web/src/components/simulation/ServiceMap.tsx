import { Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureEstimate } from '@/lib/estimate/estimate';
import { duration, percent } from '@/lib/estimate/format';
import { categoryOfKind, serviceNameOfKind } from '@/lib/simulation/coverage';
import type { ArchitectureIr } from '@infracanvas/core';

/**
 * The request path as the models see it, in order, with each hop's own figures.
 *
 * Not a copy of the canvas: this is the sequence the availability and latency
 * models actually reasoned about, which is usually a subset of what is drawn. A
 * reader comparing the two learns something real -- that the VPC and the
 * security group are configuration rather than steps a request takes, and that
 * anything else missing here was a resource no model could speak to.
 */
export function ServiceMap({
  estimate,
  document,
}: {
  estimate: ArchitectureEstimate;
  document: ArchitectureIr;
}) {
  const kinds = new Map(document.nodes.map((node) => [node.id, node.kind]));
  const hops = estimate.availability.value.nodes;
  const latencyById = new Map(
    estimate.latency?.value.contributions.map((entry) => [entry.resourceId, entry]) ?? []
  );
  const weakest = estimate.availability.value.weakest;

  if (hops.length === 0) {
    return (
      <Panel>
        <PanelHead title="The request path" />
        <p className="text-muted-foreground text-xs">
          Nothing on this canvas serves requests, so there is no path to model. Add a compute or
          database resource and it will appear here.
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead
        title="The request path"
        aside={`${hops.length} hop${hops.length === 1 ? '' : 's'} in series`}
      />
      <div className="flex flex-wrap items-stretch gap-1">
        {hops.map((hop, index) => {
          const kind = kinds.get(hop.resourceId);
          const category = kind === undefined ? null : categoryOfKind(kind);
          const contribution = latencyById.get(hop.resourceId);
          const saturation = contribution?.utilisation ?? 0;

          return (
            <div key={hop.resourceId} className="flex items-stretch gap-1">
              {index > 0 && (
                <span className="text-muted-foreground self-center" aria-hidden>
                  →
                </span>
              )}
              <div
                className={
                  hop.resourceId === weakest
                    ? 'border-destructive/60 bg-destructive/[0.06] min-w-[9rem] border p-2'
                    : 'border-border min-w-[9rem] border p-2'
                }
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0"
                    style={{ background: category?.colour ?? '#9ca3af' }}
                    aria-hidden
                  />
                  <span className="truncate text-xs font-medium">{hop.resourceId}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                  {kind === undefined ? hop.serviceId : serviceNameOfKind(kind)}
                </p>

                <dl className="mt-1.5 space-y-0.5 text-[10px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Available</dt>
                    <dd className="tabular">{percent(hop.availability)}</dd>
                  </div>
                  {contribution !== undefined && (
                    <>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Adds</dt>
                        <dd className="tabular">{duration(contribution.totalMs)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Busy</dt>
                        <dd className="tabular">{(saturation * 100).toFixed(1)}%</dd>
                      </div>
                    </>
                  )}
                </dl>

                <p className="text-muted-foreground mt-1 text-[9px] uppercase tracking-wide">
                  {hop.basis === 'published' ? 'Published SLA' : 'Modelled'}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {weakest !== '' && (
        <p className="text-muted-foreground mt-3 text-[11px]">
          <span className="text-foreground font-medium">{weakest}</span> is the weakest link: it has
          the lowest availability on the path, so it sets the ceiling for the whole composition.
        </p>
      )}
    </Panel>
  );
}
