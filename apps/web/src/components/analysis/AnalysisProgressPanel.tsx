/**
 * What a running analysis is doing, while it does it.
 *
 * The bar is driven by the fraction the worker reports rather than by elapsed
 * time. A time-based bar is a guess, and it is most confidently wrong exactly
 * when the user is trying to work out whether anything is happening at all.
 */
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { AnalysisProgress } from '@/lib/hooks/use-analysis-progress';

interface AnalysisProgressPanelProps {
  progress: AnalysisProgress;
  /** The branch being analysed, so the panel says which run this is. */
  branch: string;
}

export function AnalysisProgressPanel({ progress, branch }: AnalysisProgressPanelProps) {
  const failed = progress.status === 'failed';
  const done = progress.status === 'succeeded';
  const percent = Math.round(progress.fraction * 100);

  return (
    <div
      className="mb-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
      // Announced so a screen reader hears the step change rather than only the
      // percentage silently moving.
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {failed ? (
          <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden />
        ) : done ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />
        )}
        <p className="text-sm font-medium text-gray-900 dark:text-white">
          {failed ? 'Analysis failed' : done ? 'Analysis finished' : 'Analysing'}{' '}
          <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{branch}</span>
        </p>
        <span className="ml-auto font-mono text-xs text-gray-400">{percent}%</span>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            failed ? 'bg-red-500' : 'bg-blue-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p
        className={`mt-2 text-xs ${
          progress.level === 'info' ? 'text-gray-500 dark:text-gray-400' : 'text-amber-600'
        } ${failed ? 'text-red-600' : ''}`}
      >
        {progress.message}
      </p>
    </div>
  );
}
