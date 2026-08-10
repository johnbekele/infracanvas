import { useEffect } from 'react';
import { Github, Loader2, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/stores/auth-store';
import type { AuthMethodId } from '@/lib/api/client';

const LABELS: Record<AuthMethodId, { title: string; icon: typeof Github }> = {
  oauth: { title: 'Sign in with GitHub', icon: Github },
  token: { title: 'Use this machine’s GitHub token', icon: Terminal },
};

/**
 * The sign-in choice, made by the person signing in.
 *
 * Both methods are shown even when one cannot be used, with the reason, because
 * hiding it turns "OAuth is not configured" into "the button I was told about
 * is not there". A method that cannot complete is disabled rather than absent.
 */
export function AuthMethodPicker() {
  const { methods, defaultMethod, loadMethods, login, isLoading } = useAuthStore();

  useEffect(() => {
    void loadMethods();
  }, [loadMethods]);

  if (methods.length === 0) {
    return (
      <Button onClick={() => login()} disabled={isLoading}>
        {isLoading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Github className="mr-2 h-4 w-4" />
        )}
        Connect GitHub
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      {methods.map((method) => {
        const { title, icon: Icon } = LABELS[method.id];
        const recommended = method.available && method.id === defaultMethod;

        return (
          <div key={method.id} className="space-y-1">
            <Button
              variant={recommended ? 'default' : 'outline'}
              className="w-full justify-start"
              disabled={!method.available || isLoading}
              onClick={() => login(method.id)}
            >
              <Icon className="mr-2 h-4 w-4" />
              {title}
              {recommended && <span className="ml-auto text-xs opacity-70">Recommended</span>}
            </Button>
            <p className="px-1 text-xs text-gray-500 dark:text-gray-400">
              {method.available ? method.description : method.reason}
            </p>
          </div>
        );
      })}
    </div>
  );
}
