import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';

interface NotConfiguredCardProps {
  message: string;
}

export function NotConfiguredCard({ message }: NotConfiguredCardProps) {
  return (
    <div className="mx-3 mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-xs text-amber-900 dark:text-amber-100">{message}</p>
      <Link
        to="/settings"
        className="border-input bg-background hover:bg-accent mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-xs font-medium"
      >
        <Settings className="h-3.5 w-3.5" />
        Open settings
      </Link>
    </div>
  );
}
