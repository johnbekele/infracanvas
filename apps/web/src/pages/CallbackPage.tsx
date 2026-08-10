import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAuthStore } from '@/lib/stores/auth-store';

export function CallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { checkAuth } = useAuthStore();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const success = searchParams.get('success');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setStatus('error');
        setError(decodeURIComponent(errorParam));
        return;
      }

      if (success === 'true') {
        // OAuth completed successfully - refresh auth state
        try {
          await checkAuth();
          setStatus('success');

          // Signing in exists to reach a repository, so that is where it lands.
          setTimeout(() => {
            navigate('/repositories', { replace: true });
          }, 1500);
        } catch (_err) {
          setStatus('error');
          setError('Failed to complete authentication');
        }
        return;
      }

      // No success or error - might be direct navigation
      setStatus('error');
      setError('Invalid callback');
    };

    handleCallback();
  }, [searchParams, navigate, checkAuth]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="mx-4 max-w-md text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-violet-600" />
            <h1 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
              Completing Authentication
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Please wait while we complete your sign in...
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" />
            <h1 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
              Successfully Connected
            </h1>
            <p className="text-gray-600 dark:text-gray-400">Taking you to your repositories...</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="mx-auto mb-4 h-12 w-12 text-red-500" />
            <h1 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
              Authentication Error
            </h1>
            <p className="mb-6 text-gray-600 dark:text-gray-400">{error}</p>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => navigate('/designer')}
                className="px-4 py-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
              >
                Return to Designer
              </button>
              <button
                onClick={() => (window.location.href = '/')}
                className="rounded-lg bg-violet-600 px-4 py-2 text-white hover:bg-violet-700"
              >
                Try Again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
