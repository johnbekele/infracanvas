import { useState } from 'react';
import { Github, Key, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useGitHubStore } from '@/lib/github/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface GitHubSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GitHubSettingsDialog({ open, onOpenChange }: GitHubSettingsDialogProps) {
  const { user, isAuthenticated, isLoading, error, setToken, clearToken } = useGitHubStore();
  const [inputToken, setInputToken] = useState('');

  const handleSave = async () => {
    if (inputToken.trim()) {
      await setToken(inputToken.trim());
      setInputToken('');
    }
  };

  const handleDisconnect = () => {
    clearToken();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      {/* Dialog */}
      <div className="relative mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-900">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-900 dark:bg-white">
            <Github className="h-6 w-6 text-white dark:text-gray-900" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">GitHub Settings</h2>
            <p className="text-sm text-gray-500">Connect to push your infrastructure code</p>
          </div>
        </div>

        {/* Content */}
        {isAuthenticated && user ? (
          <div className="space-y-4">
            {/* Connected User */}
            <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
              <img src={user.avatar_url} alt={user.login} className="h-10 w-10 rounded-full" />
              <div className="flex-1">
                <p className="font-medium text-gray-900 dark:text-white">
                  {user.name || user.login}
                </p>
                <p className="text-sm text-gray-500">@{user.login}</p>
              </div>
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>

            <Button variant="destructive" className="w-full" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Token Input */}
            <div className="space-y-2">
              <Label htmlFor="github-token">Personal Access Token</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  id="github-token"
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxx"
                  value={inputToken}
                  onChange={(e) => setInputToken(e.target.value)}
                  className="pl-10"
                  disabled={isLoading}
                />
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <XCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
            </div>

            {/* Instructions */}
            <div className="space-y-2 rounded-lg bg-gray-50 p-4 text-sm dark:bg-gray-800">
              <p className="font-medium text-gray-900 dark:text-white">How to create a token:</p>
              <ol className="list-inside list-decimal space-y-1 text-gray-600 dark:text-gray-400">
                <li>Go to GitHub Settings → Developer Settings</li>
                <li>Personal Access Tokens → Tokens (classic)</li>
                <li>
                  Generate new token with{' '}
                  <code className="rounded bg-gray-200 px-1 dark:bg-gray-700">repo</code> scope
                </li>
              </ol>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=InfraCanvas"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-violet-600 hover:text-violet-700"
              >
                Create token on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleSave}
              disabled={!inputToken.trim() || isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Github className="h-4 w-4" />
                  Connect
                </>
              )}
            </Button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-800">
          <p className="text-center text-xs text-gray-500">
            Your token is stored locally and never sent to any server.
          </p>
        </div>

        {/* Close button */}
        <button
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600"
        >
          <XCircle className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
