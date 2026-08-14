import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The surfaces the simulation is read on.
 *
 * Corner ticks instead of rounded shadows, because the page is a technical
 * drawing rather than a feed: the ticks mark where a panel begins and ends
 * without drawing a heavy border around every figure, and a page of forty
 * numbers needs its divisions quiet.
 *
 * There is no `elevated` variant that raises a card above its neighbours by
 * default. Emphasis here should come from what a panel says -- a blind spot is
 * loud because it is a warning, not because it is a card.
 */

export function Corners() {
  return (
    <>
      <span className="border-foreground/25 pointer-events-none absolute left-0 top-0 h-2 w-2 border-l border-t" />
      <span className="border-foreground/25 pointer-events-none absolute right-0 top-0 h-2 w-2 border-r border-t" />
      <span className="border-foreground/25 pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-b border-l" />
      <span className="border-foreground/25 pointer-events-none absolute bottom-0 right-0 h-2 w-2 border-b border-r" />
    </>
  );
}

export function Panel({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  /** `warn` is for a panel that reports a gap, which should read as one. */
  tone?: 'default' | 'warn';
}) {
  return (
    <section
      className={cn(
        'relative border p-4',
        tone === 'warn'
          ? 'border-[hsl(var(--ink-warn))]/40 bg-[hsl(var(--ink-warn))]/[0.06]'
          : 'border-border bg-card',
        className
      )}
    >
      <Corners />
      {children}
    </section>
  );
}

/**
 * A panel heading and, to its right, the one fact that qualifies everything
 * under it: how many resources a total left out, how many rules ran.
 */
export function PanelHead({
  title,
  aside,
  icon,
}: {
  title: string;
  aside?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h4 className="text-foreground flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
        {icon}
        {title}
      </h4>
      {aside !== undefined && (
        <span className="text-muted-foreground shrink-0 text-[11px]">{aside}</span>
      )}
    </div>
  );
}

/** A small caps label, used above figures and along chart axes. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground text-[10px] font-medium uppercase tracking-[0.08em]',
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A figure with its unit set smaller beside it, so a column of them aligns on
 * the digits rather than on whatever the unit happens to be.
 */
export function Figure({
  value,
  unit,
  className,
}: {
  value: string;
  unit?: string;
  className?: string;
}) {
  return (
    <span className={cn('flex items-baseline gap-1', className)}>
      <span className="tabular font-heading text-2xl font-semibold leading-none">{value}</span>
      {unit !== undefined && <span className="text-muted-foreground text-xs">{unit}</span>}
    </span>
  );
}
