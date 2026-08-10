import { reasoningScales, type ReasoningScale } from '@infracanvas/core';

interface ReasoningControlProps {
  value: ReasoningScale;
  onChange: (scale: ReasoningScale) => void;
  disabled?: boolean;
}

/**
 * How hard the model should think.
 *
 * One control rather than a provider-specific parameter, because the question
 * is the same whoever answers it and the person paying for the tokens should
 * not have to know that OpenAI calls it effort and Anthropic calls it a
 * thinking budget.
 */
export function ReasoningControl({ value, onChange, disabled }: ReasoningControlProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {reasoningScales.map((scale) => {
        const selected = scale.id === value;

        return (
          <button
            key={scale.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(scale.id)}
            className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
              selected
                ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700'
            }`}
          >
            <span className="block text-sm font-medium text-gray-900 dark:text-white">
              {scale.label}
            </span>
            <span className="mt-0.5 block text-xs text-gray-500">{scale.description}</span>
          </button>
        );
      })}
    </div>
  );
}
