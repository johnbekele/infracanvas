import { Panel, PanelHead } from '@/components/ui/blueprint';
import type { ArchitectureFindings } from '@infracanvas/core';
import { pillarCoverage } from '@/lib/simulation/coverage';

/**
 * The Well-Architected pillars, with what was checked in each.
 *
 * Rules exist today for one resource kind across three pillars, so three of
 * these read "no rules yet". That is deliberate and it is the honest display: a
 * row of six ticks would tell the reader their architecture passed a review
 * that was never performed, and they would act on it.
 */
export function PillarCoverage({ findings }: { findings: ArchitectureFindings }) {
  const coverage = pillarCoverage(findings);
  const checked = coverage.filter((pillar) => pillar.checked);
  const rules = checked.reduce((sum, pillar) => sum + pillar.rulesAvailable, 0);

  return (
    <Panel>
      <PanelHead
        title="Well-Architected"
        aside={`${rules} rule${rules === 1 ? '' : 's'} across ${checked.length} of 6 pillars`}
      />

      <ul className="space-y-1.5">
        {coverage.map((pillar) => (
          <li key={pillar.pillar} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0"
              style={{
                background: !pillar.checked
                  ? 'hsl(var(--muted-foreground) / 0.35)'
                  : pillar.highSeverity > 0
                    ? 'hsl(var(--destructive))'
                    : pillar.findings > 0
                      ? 'hsl(var(--ink-warn))'
                      : 'hsl(var(--ink-availability))',
              }}
              aria-hidden
            />
            <span className="flex-1 truncate">{pillar.name}</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {!pillar.checked
                ? 'no rules yet'
                : pillar.findings === 0
                  ? `clean, ${pillar.rulesAvailable} checked`
                  : `${pillar.findings} finding${pillar.findings === 1 ? '' : 's'}`}
            </span>
          </li>
        ))}
      </ul>

      {findings.unchecked.length > 0 && (
        <p className="border-border text-muted-foreground mt-3 border-t pt-2 text-[11px]">
          {findings.unchecked.length} resource kind
          {findings.unchecked.length === 1 ? '' : 's'} on this canvas have no rules at all, so their
          silence here is absence of a check rather than a pass.
        </p>
      )}
    </Panel>
  );
}
