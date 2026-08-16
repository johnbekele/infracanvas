import type { CitationView } from '@/lib/copilot/types';

interface CitationChipProps {
  scheme: CitationView['scheme'];
  target: string;
  verified: boolean;
}

export function CitationChip({ scheme, target, verified }: CitationChipProps) {
  const label = `${scheme}:${target}`;

  if (!verified) {
    return (
      <mark
        className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"
        title="Unverified citation"
      >
        {label}
      </mark>
    );
  }

  if (scheme === 'file') {
    return (
      <a
        href={`#cite-${encodeURIComponent(target)}`}
        className="rounded bg-sky-50 px-1 py-0.5 font-mono text-[10px] text-sky-700 underline-offset-2 hover:underline dark:bg-sky-950/40 dark:text-sky-300"
      >
        {label}
      </a>
    );
  }

  return (
    <a
      href={`#cite-${scheme}-${encodeURIComponent(target)}`}
      className="rounded bg-sky-50 px-1 py-0.5 font-mono text-[10px] text-sky-700 underline-offset-2 hover:underline dark:bg-sky-950/40 dark:text-sky-300"
    >
      {label}
    </a>
  );
}
