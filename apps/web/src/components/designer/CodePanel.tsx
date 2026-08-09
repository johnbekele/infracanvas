import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Copy, Check, Code2, FileCode, ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react';
import { useDesignerStore, type PulumiLanguage } from '@/lib/stores/designer-store';
import { generateTerraform, generatePulumi } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 250;
const MOBILE_DEFAULT_HEIGHT = 180;

interface CodePanelProps {
  isMobile?: boolean;
}

export function CodePanel({ isMobile = false }: CodePanelProps) {
  const { nodes, edges, activeTab, setActiveTab, pulumiLanguage, setPulumiLanguage } =
    useDesignerStore();
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!isMobile);
  const [height, setHeight] = useState(isMobile ? MOBILE_DEFAULT_HEIGHT : DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const terraformCode = useMemo(() => generateTerraform(nodes, edges), [nodes, edges]);

  const pulumiCode = useMemo(
    () => generatePulumi(nodes, edges, pulumiLanguage),
    [nodes, edges, pulumiLanguage]
  );

  const copyToClipboard = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const currentCode = activeTab === 'terraform' ? terraformCode : pulumiCode;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startYRef.current = e.clientY;
      startHeightRef.current = height;
    },
    [height]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      const deltaY = startYRef.current - e.clientY;
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeightRef.current + deltaY));
      setHeight(newHeight);

      // Auto-collapse if dragged below minimum
      if (newHeight <= MIN_HEIGHT + 10) {
        setIsExpanded(false);
      } else {
        setIsExpanded(true);
      }
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const toggleExpanded = () => {
    if (isExpanded) {
      setIsExpanded(false);
    } else {
      setIsExpanded(true);
      if (height <= MIN_HEIGHT + 10) {
        setHeight(DEFAULT_HEIGHT);
      }
    }
  };

  return (
    <div
      ref={panelRef}
      className="flex flex-col border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
      style={{ height: isExpanded ? height : MIN_HEIGHT }}
    >
      {/* Resize Handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`group flex h-2 cursor-ns-resize items-center justify-center transition-colors hover:bg-violet-500/10 ${isDragging ? 'bg-violet-500/20' : ''} `}
      >
        <GripHorizontal
          className={`h-3 w-8 text-gray-300 group-hover:text-violet-500 dark:text-gray-600 ${isDragging ? 'text-violet-500' : ''}`}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-2 py-1.5 md:px-4 dark:border-gray-800">
        <div className="flex min-w-0 items-center gap-1 md:gap-2">
          <Code2 className="h-4 w-4 shrink-0 text-gray-500" />
          <span className="truncate text-xs font-medium text-gray-700 md:text-sm dark:text-gray-300">
            {isMobile ? 'Code' : 'Generated Code'}
          </span>
          <span className="shrink-0 text-[10px] text-gray-400 md:text-xs">({nodes.length})</span>
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          <Tabs
            value={activeTab === 'properties' ? 'terraform' : activeTab}
            onValueChange={(v) => setActiveTab(v as 'terraform' | 'pulumi')}
          >
            <TabsList className="h-7 md:h-8">
              <TabsTrigger
                value="terraform"
                className="h-6 px-2 text-[10px] md:h-7 md:px-3 md:text-xs"
              >
                {!isMobile && <FileCode className="mr-1 h-3 w-3" />}
                TF
              </TabsTrigger>
              <TabsTrigger
                value="pulumi"
                className="h-6 px-2 text-[10px] md:h-7 md:px-3 md:text-xs"
              >
                {!isMobile && <FileCode className="mr-1 h-3 w-3" />}
                Pulumi
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Pulumi Language Toggle */}
          {(activeTab === 'pulumi' || (activeTab === 'properties' && false)) && (
            <ToggleGroup
              type="single"
              value={pulumiLanguage}
              onValueChange={(v) => v && setPulumiLanguage(v as PulumiLanguage)}
              className="h-7 md:h-8"
            >
              <ToggleGroupItem
                value="typescript"
                className="h-6 px-2 text-[10px] data-[state=on]:bg-violet-100 data-[state=on]:text-violet-700 md:h-7 md:text-xs dark:data-[state=on]:bg-violet-900 dark:data-[state=on]:text-violet-300"
              >
                TS
              </ToggleGroupItem>
              <ToggleGroupItem
                value="python"
                className="h-6 px-2 text-[10px] data-[state=on]:bg-violet-100 data-[state=on]:text-violet-700 md:h-7 md:text-xs dark:data-[state=on]:bg-violet-900 dark:data-[state=on]:text-violet-300"
              >
                PY
              </ToggleGroupItem>
            </ToggleGroup>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5 md:h-8 md:px-2"
            onClick={() => copyToClipboard(currentCode)}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-green-500 md:h-3.5 md:w-3.5" />
                <span className="hidden text-[10px] sm:inline md:text-xs">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 md:h-3.5 md:w-3.5" />
                <span className="hidden text-[10px] sm:inline md:text-xs">Copy</span>
              </>
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 md:h-8 md:w-8"
            onClick={toggleExpanded}
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Code Content */}
      {isExpanded && (
        <div className="flex-1 overflow-auto">
          <pre className="p-4 font-mono text-xs leading-relaxed text-gray-800 dark:text-gray-200">
            <code>{currentCode}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
