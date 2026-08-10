import { CheckCircle2, Star, Trash2, XCircle } from 'lucide-react';
import { getProvider } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import type { LlmCredential } from '@/lib/api/settings';
import {
  useDeleteCredential,
  useMakeDefaultCredential,
  useVerifyCredential,
} from '@/lib/hooks/use-settings';

function VerifyButton({ id }: { id: string }) {
  const verify = useVerifyCredential();
  const result = verify.data;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => verify.mutate(id)}
        disabled={verify.isPending}
      >
        {verify.isPending ? 'Checking…' : 'Test'}
      </Button>
      {result?.ok && (
        <span className="flex items-center gap-1 text-xs text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5" /> Working
        </span>
      )}
      {result && !result.ok && (
        <span className="flex items-center gap-1 text-xs text-red-600" title={result.error}>
          <XCircle className="h-3.5 w-3.5" /> {result.error}
        </span>
      )}
    </div>
  );
}

export function CredentialList({ credentials }: { credentials: LlmCredential[] }) {
  const makeDefault = useMakeDefaultCredential();
  const remove = useDeleteCredential();

  if (credentials.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No models configured. Architecture proposals still work without one; they come from the
        deterministic rules alone, without a written explanation or critique.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {credentials.map((credential) => (
        <li key={credential.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
              {getProvider(credential.provider)?.name ?? credential.provider}
              <span className="font-normal text-gray-500">{credential.model}</span>
              {credential.isDefault && (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  Default
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {credential.keyHint ? `Key ending ${credential.keyHint}` : 'No key needed'}
              {credential.baseUrl ? ` · ${credential.baseUrl}` : ''}
            </p>
          </div>

          <VerifyButton id={credential.id} />

          {!credential.isDefault && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => makeDefault.mutate(credential.id)}
              disabled={makeDefault.isPending}
              title="Use this model by default"
            >
              <Star className="h-4 w-4" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => remove.mutate(credential.id)}
            disabled={remove.isPending}
            title="Remove"
          >
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
