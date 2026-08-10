import { Link } from 'react-router-dom';
import { GitBranch, Lock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConnectedRepository } from '@/lib/api/repositories';

interface RepositoryCardProps {
  repository: ConnectedRepository;
  onDisconnect: (id: string) => void;
  isDisconnecting: boolean;
}

export function RepositoryCard({ repository, onDisconnect, isDisconnecting }: RepositoryCardProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-violet-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-violet-700">
      <Link to={`/repositories/${repository.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-gray-900 dark:text-white">
            {repository.githubOwner}/{repository.githubName}
          </span>
          {repository.isPrivate && <Lock className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <GitBranch className="h-3.5 w-3.5" />
          {repository.defaultBranch}
        </div>
      </Link>

      <Button
        variant="ghost"
        size="icon"
        disabled={isDisconnecting}
        onClick={() => onDisconnect(repository.id)}
        aria-label={`Disconnect ${repository.githubOwner}/${repository.githubName}`}
      >
        <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-600" />
      </Button>
    </div>
  );
}
