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
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center">
            <svg
              className="w-5 h-5 text-white"
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
          {!isLoading && (
            isAuthenticated ? (
              <UserMenu />
            ) : (
              <LoginButton size="sm" />
            )
          )}
        </div>
      </header>

      {/* Designer Canvas */}
      <DesignerCanvas />
    </div>
  );
}
