import { Link, useLocation } from 'react-router-dom';
import { LoginButton, UserMenu } from '@/components/auth';
import { useAuthStore } from '@/lib/stores/auth-store';
import { LogoIcon } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/repositories', label: 'Repositories' },
  { to: '/designer', label: 'Designer' },
  // In the nav rather than only in the account menu: this is where the model
  // key lives, and until there is one the copilot refuses every turn. A setting
  // that gates the headline feature is not an account preference.
  { to: '/settings', label: 'Settings' },
];

/**
 * The application header, shared so that the repository flow and the designer
 * cannot drift apart visually or lose the link between them.
 */
export function AppHeader() {
  const { isAuthenticated, isLoading } = useAuthStore();
  const { pathname } = useLocation();

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-6">
        <Link to="/" className="flex items-center gap-2">
          <LogoIcon className="h-8 w-8" />
          <span className="text-lg font-semibold text-gray-900 dark:text-white">InfraCanvas</span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                pathname.startsWith(item.to)
                  ? 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        {!isLoading && (isAuthenticated ? <UserMenu /> : <LoginButton size="sm" />)}
      </div>
    </header>
  );
}
