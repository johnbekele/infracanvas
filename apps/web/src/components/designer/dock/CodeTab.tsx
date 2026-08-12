import { useMemo, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDesignerStore, type PulumiLanguage } from '@/lib/stores/designer-store';
import { drift } from '@/lib/designer/code-draft';
import { generatePulumi, generateTerraform } from '@infracanvas/core';

type Target = 'terraform' | 'pulumi';

/**
 * The infrastructure code this canvas generates, and a place to change it.
 *
 * Editing is offered because the generated file is a starting point rather than
 * an answer, and a reader who cannot type into what they are reading will copy
 * it elsewhere and never come back. The cost of allowing it is that the canvas
 * and the file can disagree, so the disagreement is measured and shown rather
 * than hidden: how many lines differ, and one action to throw the edits away.
 */
export function CodeTab() {
  const { nodes, edges, pulumiLanguage, setPulumiLanguage } = useDesignerStore();
  const [target, setTarget] = useState<Target>('terraform');
  const [copied, setCopied] = useState(false);

  // Keyed by target and language: an edit to the Terraform is not an edit to the
  // Pulumi, and switching tabs should not carry one into the other.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const generated = useMemo(
    () =>
      target === 'terraform'
        ? generateTerraform(nodes, edges)
        : generatePulumi(nodes, edges, pulumiLanguage),
    [target, nodes, edges, pulumiLanguage]
  );

  const key = target === 'terraform' ? 'terraform' : `pulumi:${pulumiLanguage}`;
  const draft = drafts[key] ?? null;
  const shown = draft ?? generated;
  const changes = useMemo(() => drift(generated, draft), [generated, draft]);

  const copy = () => {
    void navigator.clipboard.writeText(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const discard = () =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <Tabs value={target} onValueChange={(value) => setTarget(value as Target)}>
          <TabsList className="h-7">
            <TabsTrigger value="terraform" className="h-6 px-2 text-[10px]">
              Terraform
            </TabsTrigger>
            <TabsTrigger value="pulumi" className="h-6 px-2 text-[10px]">
              Pulumi
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-1">
          {target === 'pulumi' && (
            <ToggleGroup
              type="single"
              value={pulumiLanguage}
              onValueChange={(value) => value && setPulumiLanguage(value as PulumiLanguage)}
              className="h-7"
            >
              <ToggleGroupItem value="typescript" className="h-6 px-1.5 text-[10px]">
                TS
              </ToggleGroupItem>
              <ToggleGroupItem value="python" className="h-6 px-1.5 text-[10px]">
                PY
              </ToggleGroupItem>
            </ToggleGroup>
          )}

          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5" onClick={copy}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {!changes.clean && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-[10px] text-amber-800 dark:text-amber-300">
            Edited: {changes.added} line{changes.added === 1 ? '' : 's'} added, {changes.removed}{' '}
            removed. The canvas no longer regenerates this file.
          </p>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5" onClick={discard}>
            <RotateCcw className="h-3 w-3" />
            <span className="text-[10px]">Discard</span>
          </Button>
        </div>
      )}

      <textarea
        value={shown}
        spellCheck={false}
        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
        aria-label={target === 'terraform' ? 'Terraform code' : 'Pulumi code'}
        className="flex-1 resize-none bg-transparent p-3 font-mono text-[11px] leading-relaxed text-gray-800 outline-none dark:text-gray-200"
      />
    </div>
  );
}
