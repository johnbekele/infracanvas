import { LogOut, User, Settings, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/lib/stores/auth-store';

const ORIGIN_COPY: Record<string, string> = {
  env: 'token from GITHUB_TOKEN',
  'gh-cli': 'token from the gh CLI',
};

export function UserMenu() {
  const { user, logout, authMethod, tokenOrigin } = useAuthStore();

  if (!user) return null;

  // The local method is otherwise silent about who it signed you in as. When
  // the gh CLI holds a different account than expected, the only symptom was
  // repositories missing from the list.
  const origin = tokenOrigin ? ORIGIN_COPY[tokenOrigin] : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1 outline-none transition-colors hover:bg-gray-100 dark:hover:bg-gray-800">
        <img src={user.githubAvatar} alt={user.githubUsername} className="h-8 w-8 rounded-full" />
        <span className="hidden text-sm font-medium text-gray-700 sm:inline dark:text-gray-300">
          {user.name || user.githubUsername}
        </span>
        <ChevronDown className="h-4 w-4 text-gray-500" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <div className="px-3 py-2">
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            {user.name || user.githubUsername}
          </p>
          <p className="text-xs text-gray-500">@{user.githubUsername}</p>
          {authMethod && (
            <p className="mt-1 text-[11px] text-gray-400">
              Signed in via {authMethod === 'oauth' ? 'GitHub OAuth' : (origin ?? 'a local token')}
            </p>
          )}
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild className="gap-2">
          <a href={`https://github.com/${user.githubUsername}`} target="_blank" rel="noreferrer">
            <User className="h-4 w-4" />
            <span>GitHub profile</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild className="gap-2">
          <Link to="/settings">
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="gap-2 text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
          onClick={logout}
        >
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
