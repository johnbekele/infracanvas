import { cn } from '@/lib/utils';

interface DeltaBadgeProps {
  label: string;
  value: string;
  partial?: boolean;
  tone?: 'neutral' | 'up' | 'down';
}

export function DeltaBadge({ label, value, partial = false, tone = 'neutral' }: DeltaBadgeProps) {
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1',
        tone === 'up' &&
          'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30',
        tone === 'down' && 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30',
        tone === 'neutral' && 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60'
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className="text-xs font-medium text-gray-900 dark:text-white">
        {value}
        {partial ? (
          <span className="ml-1 text-[10px] font-normal text-amber-700 dark:text-amber-300">
            partial
          </span>
        ) : null}
      </p>
    </div>
  );
}
