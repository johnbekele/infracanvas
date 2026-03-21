import { LogOut, User, Settings, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/lib/stores/auth-store';

export function UserMenu() {
  const { user, logout } = useAuthStore();

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors outline-none">
        <img
          src={user.githubAvatar}
          alt={user.githubUsername}
          className="w-8 h-8 rounded-full"
        />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 hidden sm:inline">
          {user.name || user.githubUsername}
        </span>
        <ChevronDown className="w-4 h-4 text-gray-500" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <div className="px-3 py-2">
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            {user.name || user.githubUsername}
          </p>
          <p className="text-xs text-gray-500">@{user.githubUsername}</p>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem className="gap-2">
          <User className="w-4 h-4" />
          <span>Profile</span>
        </DropdownMenuItem>

        <DropdownMenuItem className="gap-2">
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="gap-2 text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
          onClick={logout}
        >
          <LogOut className="w-4 h-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
