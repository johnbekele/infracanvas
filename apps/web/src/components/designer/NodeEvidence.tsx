import { FileSearch } from 'lucide-react';
import type { ServiceNodeData } from '@/lib/stores/designer-store';

const CONFIDENCE_COPY = {
  high: {
    label: 'High confidence',
    detail: 'The repository states this directly.',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  medium: {
    label: 'Medium confidence',
    detail: 'Inferred from dependencies rather than declared.',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  },
  low: {
    label: 'Low confidence',
    detail: 'A substitution worth reviewing before you deploy it.',
    className: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  },
} as const;

/**
 * Why the engine proposed a node.
 *
 * A generated architecture nobody can check is one nobody should apply. The
 * files listed here are the ones the decision was read from, so disagreeing
 * with it is a matter of opening a path rather than trusting a black box.
 */
export function NodeEvidence({ data }: { data: ServiceNodeData }) {
  if (!data.evidence?.length && !data.confidence) return null;

  const confidence = data.confidence ? CONFIDENCE_COPY[data.confidence] : null;

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
        <FileSearch className="h-3.5 w-3.5" />
        Why this is here
      </h4>

      {confidence && (
        <div className="mb-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${confidence.className}`}>
            {confidence.label}
          </span>
          <p className="mt-1 text-[11px] text-gray-500">{confidence.detail}</p>
        </div>
      )}

      {data.componentPath && (
        <p className="mb-1 text-[11px] text-gray-500">
          Deploys <span className="font-mono">{data.componentPath || 'repository root'}</span>
        </p>
      )}

      {data.evidence && data.evidence.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[11px] text-gray-400">
          {data.evidence.map((path) => (
            <li key={path} className="truncate" title={path}>
              {path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
