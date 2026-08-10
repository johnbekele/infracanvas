import { useState } from 'react';
import type { ReasoningScale } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReasoningControl } from './ReasoningControl';
import type { UserSettings } from '@/lib/api/settings';
import { useUpdateSettings } from '@/lib/hooks/use-settings';

const CURRENCIES = ['USD', 'EUR', 'GBP'];

export function PreferencesForm({ settings }: { settings: UserSettings }) {
  const [region, setRegion] = useState(settings.defaultRegion);
  const [currency, setCurrency] = useState(settings.currency);
  const [scale, setScale] = useState<ReasoningScale>(settings.reasoningScale);
  const [budget, setBudget] = useState(
    settings.monthlyTokenBudget === null ? '' : String(settings.monthlyTokenBudget)
  );

  const update = useUpdateSettings();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    update.mutate({
      defaultRegion: region,
      currency,
      reasoningScale: scale,
      // An empty field means no cap, which the server stores as null.
      monthlyTokenBudget: budget.trim() === '' ? null : Number(budget),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="region">Default region</Label>
          {/* Free text rather than a list: AWS adds regions faster than a
              hard-coded list would be updated, and the real one arrives with the
              price snapshot, which has to enumerate regions anyway. */}
          <Input
            id="region"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            required
          />
          <p className="text-xs text-gray-500">Prices and latency estimates are taken here.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <select
            id="currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-gray-800 dark:bg-gray-900"
          >
            {CURRENCIES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Reasoning effort</Label>
        <ReasoningControl value={scale} onChange={setScale} disabled={update.isPending} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="budget">Monthly token budget</Label>
        <Input
          id="budget"
          type="number"
          min={1}
          step={1}
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          placeholder="No limit"
          className="sm:max-w-xs"
        />
        <p className="text-xs text-gray-500">
          Model calls stop once this is reached in a month. Leave empty for no limit.
        </p>
      </div>

      {update.isError && (
        <p className="text-sm text-red-600">
          {update.error instanceof Error ? update.error.message : 'Could not save.'}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        {update.isSuccess && !update.isPending && (
          <span className="text-sm text-green-600">Saved</span>
        )}
      </div>
    </form>
  );
}
