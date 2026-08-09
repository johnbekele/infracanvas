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
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem className="gap-2">
          <User className="h-4 w-4" />
          <span>Profile</span>
        </DropdownMenuItem>

        <DropdownMenuItem className="gap-2">
          <Settings className="h-4 w-4" />
          <span>Settings</span>
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
