import { useState } from 'react';
import { getProvider, llmProviders, type LlmProvider } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAddCredential } from '@/lib/hooks/use-settings';

/**
 * Adding a model to work against.
 *
 * The key field disappears entirely for providers that do not have one, rather
 * than being shown and ignored: Bedrock authenticates through the AWS
 * credentials the server already holds, and Ollama is a process on localhost.
 * Asking for a key there would mean asking the user to invent one.
 */
export function CredentialForm() {
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [model, setModel] = useState(getProvider('anthropic')?.suggestedModels[0] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const addCredential = useAddCredential();
  const info = getProvider(provider);

  const selectProvider = (next: LlmProvider) => {
    setProvider(next);
    setModel(getProvider(next)?.suggestedModels[0] ?? '');
    setApiKey('');
    setBaseUrl(getProvider(next)?.defaultBaseUrl ?? '');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    addCredential.mutate(
      {
        provider,
        model,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        makeDefault: true,
      },
      { onSuccess: () => setApiKey('') }
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="provider">Provider</Label>
          <select
            id="provider"
            value={provider}
            onChange={(event) => selectProvider(event.target.value as LlmProvider)}
            className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-gray-800 dark:bg-gray-900"
          >
            {llmProviders.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="model">Model</Label>
          <Input
            id="model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            list="model-suggestions"
            placeholder="Model name"
            required
          />
          {/* Suggestions rather than a fixed list: model names change far more
              often than this application is released. */}
          <datalist id="model-suggestions">
            {info?.suggestedModels.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
      </div>

      {info?.requiresApiKey && (
        <div className="space-y-1.5">
          <Label htmlFor="apiKey">API key</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Stored encrypted; never shown again"
            autoComplete="off"
            required
          />
        </div>
      )}

      {info?.supportsBaseUrl && (
        <div className="space-y-1.5">
          <Label htmlFor="baseUrl">Base URL</Label>
          <Input
            id="baseUrl"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={info.defaultBaseUrl ?? 'Optional, for a proxy or self-hosted endpoint'}
          />
        </div>
      )}

      {addCredential.isError && (
        <p className="text-sm text-red-600">
          {addCredential.error instanceof Error
            ? addCredential.error.message
            : 'Could not save the credential.'}
        </p>
      )}

      <Button type="submit" disabled={addCredential.isPending}>
        {addCredential.isPending ? 'Saving…' : 'Save credential'}
      </Button>
    </form>
  );
}
