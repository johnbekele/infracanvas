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

          // Redirect to designer after a brief delay
          setTimeout(() => {
            navigate('/designer', { replace: true });
          }, 1500);
        } catch (err) {
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="text-center max-w-md mx-4">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 text-violet-600 animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Completing Authentication
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Please wait while we complete your sign in...
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Successfully Connected
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Redirecting to designer...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Authentication Error
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-6">{error}</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => navigate('/designer')}
                className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                Return to Designer
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
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
