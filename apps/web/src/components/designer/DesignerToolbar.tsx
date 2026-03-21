import { useState } from 'react';
import {
  Download, Trash2, ZoomIn, ZoomOut,
  Maximize2, FileDown, Image, PanelLeftClose, PanelLeft,
  FolderArchive, Loader2, Github
} from 'lucide-react';
import { useReactFlow } from 'reactflow';
import { useDesignerStore, PulumiLanguage } from '@/lib/stores/designer-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  generateTerraformProject,
  generatePulumiProject,
  exportTerraformZip,
  exportPulumiZip,
  downloadBlob,
} from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PushToGitHubDialog } from '@/components/github/PushToGitHubDialog';

interface DesignerToolbarProps {
  isMobile?: boolean;
}

export function DesignerToolbar({ isMobile = false }: DesignerToolbarProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const {
    nodes,
    edges,
    designName,
    setDesignName,
    clearCanvas,
    isDirty,
    isPanelOpen,
    setPanelOpen,
  } = useDesignerStore();

  const { isAuthenticated, user } = useAuthStore();

  const [isEditingName, setIsEditingName] = useState(false);
  const [isExporting, setIsExporting] = useState<'terraform' | 'pulumi' | null>(null);
  const [showPushDialog, setShowPushDialog] = useState(false);

  const downloadTerraformZip = async () => {
    if (nodes.length === 0) return;

    setIsExporting('terraform');
    try {
      const project = generateTerraformProject(nodes, edges);
      const { blob, filename } = await exportTerraformZip(project, designName);
      downloadBlob(blob, filename);
    } catch (error) {
      console.error('Failed to export Terraform ZIP:', error);
    } finally {
      setIsExporting(null);
    }
  };

  const downloadPulumiZip = async (language: PulumiLanguage = 'typescript') => {
    if (nodes.length === 0) return;

    setIsExporting('pulumi');
    try {
      const project = generatePulumiProject(nodes, edges, language);
      const { blob, filename } = await exportPulumiZip(project, designName, language);
      downloadBlob(blob, filename);
    } catch (error) {
      console.error('Failed to export Pulumi ZIP:', error);
    } finally {
      setIsExporting(null);
    }
  };

  return (
    <TooltipProvider>
      <div className="h-12 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between px-2 md:px-4">
        {/* Left: Design Name */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-shrink">
          {isEditingName ? (
            <Input
              value={designName}
              onChange={(e) => setDesignName(e.target.value)}
              onBlur={() => setIsEditingName(false)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditingName(false)}
              className="h-8 w-32 md:w-48 text-sm font-medium"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setIsEditingName(true)}
              className="text-xs md:text-sm font-medium text-gray-900 dark:text-white hover:text-violet-600 dark:hover:text-violet-400 transition-colors truncate max-w-[100px] md:max-w-none"
            >
              {designName}
              {isDirty && <span className="text-orange-500 ml-1">*</span>}
            </button>
          )}
        </div>

        {/* Center: Actions - Hidden on mobile, shown in dropdown */}
        {!isMobile && (
          <div className="flex items-center gap-1">
            {/* Zoom Controls */}
            <div className="flex items-center gap-1 px-2 border-r border-gray-200 dark:border-gray-700">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => zoomOut()}>
                    <ZoomOut className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom Out</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => zoomIn()}>
                    <ZoomIn className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom In</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fitView()}>
                    <Maximize2 className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Fit View</TooltipContent>
              </Tooltip>
            </div>

            {/* Clear Canvas */}
            <div className="flex items-center gap-1 px-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                    onClick={() => {
                      if (nodes.length > 0 && confirm('Clear all services from canvas?')) {
                        clearCanvas();
                      }
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear Canvas</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

        {/* Right: Export & Actions */}
        <div className="flex items-center gap-1 md:gap-2">
          {/* Mobile: Combined actions menu */}
          {isMobile && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Maximize2 className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => zoomIn()}>
                  <ZoomIn className="w-4 h-4 mr-2" />
                  Zoom In
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => zoomOut()}>
                  <ZoomOut className="w-4 h-4 mr-2" />
                  Zoom Out
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => fitView()}>
                  <Maximize2 className="w-4 h-4 mr-2" />
                  Fit View
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-500"
                  onClick={() => {
                    if (nodes.length > 0 && confirm('Clear all services from canvas?')) {
                      clearCanvas();
                    }
                  }}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear Canvas
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* GitHub Push Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isAuthenticated ? 'ghost' : 'outline'}
                size="sm"
                className="h-8 gap-1 md:gap-2 px-2 md:px-3"
                onClick={() => setShowPushDialog(true)}
              >
                {isAuthenticated && user ? (
                  <>
                    <img
                      src={user.githubAvatar}
                      alt={user.githubUsername}
                      className="w-4 h-4 rounded-full"
                    />
                    <span className="hidden sm:inline">Push</span>
                  </>
                ) : (
                  <>
                    <Github className="w-4 h-4" />
                    <span className="hidden sm:inline">GitHub</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isAuthenticated ? 'Push to GitHub' : 'Connect GitHub'}
            </TooltipContent>
          </Tooltip>

          {/* Export Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 md:gap-2 px-2 md:px-3"
                disabled={nodes.length === 0 || isExporting !== null}
              >
                {isExporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* Push to GitHub */}
              <DropdownMenuItem
                onClick={() => setShowPushDialog(true)}
                className="gap-2"
              >
                <Github className="w-4 h-4" />
                <div className="flex flex-col">
                  <span>Push to GitHub</span>
                  <span className="text-xs text-muted-foreground">
                    {isAuthenticated ? 'Commit to repository' : 'Connect first'}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={downloadTerraformZip}
                disabled={isExporting !== null}
                className="gap-2"
              >
                {isExporting === 'terraform' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FolderArchive className="w-4 h-4" />
                )}
                <div className="flex flex-col">
                  <span>Terraform Project</span>
                  <span className="text-xs text-muted-foreground">
                    Modular .tf files + modules
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={isExporting !== null} className="gap-2">
                  {isExporting === 'pulumi' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FolderArchive className="w-4 h-4" />
                  )}
                  <div className="flex flex-col">
                    <span>Pulumi Project</span>
                    <span className="text-xs text-muted-foreground">
                      TypeScript or Python
                    </span>
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() => downloadPulumiZip('typescript')}
                    disabled={isExporting !== null}
                    className="gap-2"
                  >
                    <FileDown className="w-4 h-4" />
                    <div className="flex flex-col">
                      <span>TypeScript</span>
                      <span className="text-xs text-muted-foreground">
                        index.ts + components
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => downloadPulumiZip('python')}
                    disabled={isExporting !== null}
                    className="gap-2"
                  >
                    <FileDown className="w-4 h-4" />
                    <div className="flex flex-col">
                      <span>Python</span>
                      <span className="text-xs text-muted-foreground">
                        __main__.py + components
                      </span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled className="gap-2">
                <Image className="w-4 h-4" />
                <div className="flex flex-col">
                  <span>Export as PNG</span>
                  <span className="text-xs text-muted-foreground">
                    Coming soon
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPanelOpen(!isPanelOpen)}
              >
                {isPanelOpen ? (
                  <PanelLeftClose className="w-4 h-4" />
                ) : (
                  <PanelLeft className="w-4 h-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isPanelOpen ? 'Hide Properties' : 'Show Properties'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Push Dialog */}
      <PushToGitHubDialog
        open={showPushDialog}
        onOpenChange={setShowPushDialog}
      />
    </TooltipProvider>
  );
}
