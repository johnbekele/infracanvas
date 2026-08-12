import type { ArchitectureFindings, Pillar } from '@infracanvas/core';

const PILLAR_LABEL: Record<Pillar, string> = {
  'operational-excellence': 'Operational excellence',
  security: 'Security',
  reliability: 'Reliability',
  'performance-efficiency': 'Performance efficiency',
  'cost-optimisation': 'Cost optimisation',
  sustainability: 'Sustainability',
};

const SEVERITY_CLASS = {
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
} as const;

/**
 * Well-Architected findings, worst first, each with the remediation and the
 * field it is about. An empty list says which kinds nothing could check, because
 * silence on an architecture with no rules is indistinguishable from a pass.
 */
export function FindingsList({ findings }: { findings: ArchitectureFindings }) {
  const pillars = (Object.keys(findings.byPillar) as Pillar[]).filter(
    (pillar) => findings.byPillar[pillar].length > 0
  );

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">
          Well-Architected findings
        </h4>
        <span className="text-[10px] text-gray-500">{findings.findings.length}</span>
      </div>

      {pillars.map((pillar) => (
        <div key={pillar} className="mt-2">
          <p className="text-[9px] uppercase tracking-wide text-gray-400">{PILLAR_LABEL[pillar]}</p>
          <ul className="mt-1 space-y-1.5">
            {findings.byPillar[pillar].map((finding) => (
              <li
                key={finding.pointer + finding.ruleId}
                className="rounded-md border border-gray-200 p-2 dark:border-gray-800"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] ${SEVERITY_CLASS[finding.severity]}`}
                  >
                    {finding.severity}
                  </span>
                  <span className="font-mono text-[9px] text-gray-400">{finding.ruleId}</span>
                </div>
                <p className="mt-1 text-[11px] text-gray-800 dark:text-gray-200">
                  {finding.message}
                </p>
                <p className="mt-0.5 text-[10px] text-gray-500">{finding.remediation}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {findings.findings.length === 0 && (
        <p className="mt-1 text-[10px] text-gray-500">Nothing to report from the rules that ran.</p>
      )}

      {findings.unchecked.length > 0 && (
        <p className="mt-2 text-[10px] text-gray-500">
          No rules exist yet for {findings.unchecked.join(', ')}, so a clean result here does not
          cover them.
        </p>
      )}
    </section>
  );
}
