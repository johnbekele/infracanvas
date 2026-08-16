import { Link, useLocation } from 'react-router-dom';
import { LoginButton, UserMenu } from '@/components/auth';
import { useAuthStore } from '@/lib/stores/auth-store';
import { LogoIcon } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/repositories', label: 'Repositories' },
  { to: '/designer', label: 'Designer' },
  { to: '/simulation', label: 'Simulation' },
  { to: '/agent-loop', label: 'Agents' },
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
    <header className="border-border bg-card flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-6">
        <Link to="/" className="flex items-center gap-2">
          <LogoIcon className="h-7 w-7" />
          <span className="font-heading text-lg font-semibold uppercase tracking-wide">
            InfraCanvas
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'border-b-2 px-3 py-1.5 text-sm font-medium transition-colors',
                pathname.startsWith(item.to)
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
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
