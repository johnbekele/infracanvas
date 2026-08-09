import { useEffect } from 'react';
import { DesignerCanvas } from '@/components/designer/DesignerCanvas';
import { LoginButton, UserMenu } from '@/components/auth';
import { useAuthStore } from '@/lib/stores/auth-store';

export function DesignerPage() {
  const { isAuthenticated, isLoading, checkAuth } = useAuthStore();

  // Check auth status on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
            <svg
              className="h-5 w-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
              />
            </svg>
          </div>
          <span className="text-lg font-semibold text-gray-900 dark:text-white">InfraCanvas</span>
        </div>

        {/* Auth Section */}
        <div className="flex items-center gap-3">
          {!isLoading && (isAuthenticated ? <UserMenu /> : <LoginButton size="sm" />)}
        </div>
      </header>

      {/* Designer Canvas */}
      <DesignerCanvas />
    </div>
  );
}
