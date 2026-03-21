import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Copy, Check, Code2, FileCode, ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react';
import { useDesignerStore, PulumiLanguage } from '@/lib/stores/designer-store';
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
  const { nodes, edges, activeTab, setActiveTab, pulumiLanguage, setPulumiLanguage } = useDesignerStore();
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!isMobile);
  const [height, setHeight] = useState(isMobile ? MOBILE_DEFAULT_HEIGHT : DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const terraformCode = useMemo(
    () => generateTerraform(nodes, edges),
    [nodes, edges]
  );

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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;
  }, [height]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
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
  }, [isDragging]);

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
      className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col"
      style={{ height: isExpanded ? height : MIN_HEIGHT }}
    >
      {/* Resize Handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`
          h-2 flex items-center justify-center cursor-ns-resize
          hover:bg-violet-500/10 transition-colors group
          ${isDragging ? 'bg-violet-500/20' : ''}
        `}
      >
        <GripHorizontal className={`w-8 h-3 text-gray-300 dark:text-gray-600 group-hover:text-violet-500 ${isDragging ? 'text-violet-500' : ''}`} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-2 md:px-4 py-1.5 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-1 md:gap-2 min-w-0">
          <Code2 className="w-4 h-4 text-gray-500 shrink-0" />
          <span className="text-xs md:text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
            {isMobile ? 'Code' : 'Generated Code'}
          </span>
          <span className="text-[10px] md:text-xs text-gray-400 shrink-0">
            ({nodes.length})
          </span>
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          <Tabs
            value={activeTab === 'properties' ? 'terraform' : activeTab}
            onValueChange={(v) => setActiveTab(v as 'terraform' | 'pulumi')}
          >
            <TabsList className="h-7 md:h-8">
              <TabsTrigger value="terraform" className="text-[10px] md:text-xs h-6 md:h-7 px-2 md:px-3">
                {!isMobile && <FileCode className="w-3 h-3 mr-1" />}
                TF
              </TabsTrigger>
              <TabsTrigger value="pulumi" className="text-[10px] md:text-xs h-6 md:h-7 px-2 md:px-3">
                {!isMobile && <FileCode className="w-3 h-3 mr-1" />}
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
                className="text-[10px] md:text-xs h-6 md:h-7 px-2 data-[state=on]:bg-violet-100 data-[state=on]:text-violet-700 dark:data-[state=on]:bg-violet-900 dark:data-[state=on]:text-violet-300"
              >
                TS
              </ToggleGroupItem>
              <ToggleGroupItem
                value="python"
                className="text-[10px] md:text-xs h-6 md:h-7 px-2 data-[state=on]:bg-violet-100 data-[state=on]:text-violet-700 dark:data-[state=on]:bg-violet-900 dark:data-[state=on]:text-violet-300"
              >
                PY
              </ToggleGroupItem>
            </ToggleGroup>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-7 md:h-8 px-1.5 md:px-2 gap-1"
            onClick={() => copyToClipboard(currentCode)}
          >
            {copied ? (
              <>
                <Check className="w-3 md:w-3.5 h-3 md:h-3.5 text-green-500" />
                <span className="text-[10px] md:text-xs hidden sm:inline">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 md:w-3.5 h-3 md:h-3.5" />
                <span className="text-[10px] md:text-xs hidden sm:inline">Copy</span>
              </>
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 md:h-8 md:w-8"
            onClick={toggleExpanded}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Code Content */}
      {isExpanded && (
        <div className="flex-1 overflow-auto">
          <pre className="p-4 text-xs font-mono text-gray-800 dark:text-gray-200 leading-relaxed">
            <code>{currentCode}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
