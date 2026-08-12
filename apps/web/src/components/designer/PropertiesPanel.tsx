import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Settings, Trash2, Info } from 'lucide-react';
import { useDesignerStore } from '@/lib/stores/designer-store';
import { ZONE_PROPERTY, getServiceById, zoneNameOf } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { NodeEvidence } from './NodeEvidence';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface PropertiesPanelProps {
  isMobile?: boolean;
}

export function PropertiesPanel({ isMobile = false }: PropertiesPanelProps) {
  const {
    nodes,
    selectedNodeId,
    selectNode,
    updateNodeProperty,
    removeNode,
    isPanelOpen,
    setPanelOpen,
  } = useDesignerStore();

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  const serviceDefinition = useMemo(
    () => (selectedNode ? getServiceById(selectedNode.data.serviceId) : null),
    [selectedNode]
  );

  // The zone a node is drawn in decides its zone, so offering the choice again
  // here would let the panel disagree with both the canvas and the export.
  const zoneName = useMemo(
    () => (selectedNode ? zoneNameOf(selectedNode, nodes) : undefined),
    [selectedNode, nodes]
  );

  const handleClose = () => {
    selectNode(null);
    setPanelOpen(false);
  };

  if (!isPanelOpen || !selectedNode || !serviceDefinition) {
    return null;
  }

  const panelContent = (
    <motion.div
      initial={{ x: 300, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 300, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className={`flex flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${
        isMobile
          ? 'fixed inset-y-0 right-0 z-50 w-[90vw] max-w-[320px] shadow-2xl'
          : 'h-full w-72 md:w-80'
      } `}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-gray-200 p-3 md:p-4 dark:border-gray-800">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: selectedNode.data.color }}
            >
              <Settings className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-gray-900 md:text-base dark:text-white">
                {selectedNode.data.serviceName}
              </h3>
              <p className="text-[10px] capitalize text-gray-500 md:text-xs">
                {selectedNode.data.category}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Properties - Scrollable */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3 md:p-4">
        <NodeEvidence data={selectedNode.data} />

        <div>
          <h4 className="mb-2 text-xs font-medium text-gray-700 md:mb-3 md:text-sm dark:text-gray-300">
            Configuration
          </h4>

          <div className="space-y-3 md:space-y-4">
            {serviceDefinition.properties.map((prop) => {
              const currentValue = selectedNode.data.properties[prop.name] ?? prop.default;

              if (prop.name === ZONE_PROPERTY && zoneName) {
                return (
                  <div key={prop.name} className="space-y-1 md:space-y-1.5">
                    <Label className="flex items-center gap-1 text-[11px] md:text-xs">
                      {prop.label}
                    </Label>
                    <Input
                      value={zoneName}
                      readOnly
                      disabled
                      className="h-8 text-xs md:h-9 md:text-sm"
                    />
                    <p className="text-[9px] text-gray-500 md:text-[10px]">
                      Taken from the availability zone this sits inside.
                    </p>
                  </div>
                );
              }

              return (
                <div key={prop.name} className="space-y-1 md:space-y-1.5">
                  <Label
                    htmlFor={prop.name}
                    className="flex items-center gap-1 text-[11px] md:text-xs"
                  >
                    {prop.label}
                    {prop.required && <span className="text-red-500">*</span>}
                    {prop.description && (
                      <span className="hidden text-gray-400 md:inline" title={prop.description}>
                        <Info className="h-3 w-3" />
                      </span>
                    )}
                  </Label>

                  {prop.type === 'text' && (
                    <Input
                      id={prop.name}
                      value={String(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(selectedNode.id, prop.name, e.target.value)
                      }
                      placeholder={prop.description}
                      className="h-8 text-xs md:h-9 md:text-sm"
                    />
                  )}

                  {prop.type === 'textarea' && (
                    <Textarea
                      id={prop.name}
                      value={String(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(selectedNode.id, prop.name, e.target.value)
                      }
                      placeholder={prop.description}
                      className="min-h-[60px] resize-none text-xs md:text-sm"
                      rows={3}
                    />
                  )}

                  {prop.type === 'number' && (
                    <Input
                      id={prop.name}
                      type="number"
                      value={Number(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(selectedNode.id, prop.name, Number(e.target.value))
                      }
                      className="h-8 text-xs md:h-9 md:text-sm"
                    />
                  )}

                  {prop.type === 'select' && prop.options && (
                    <Select
                      value={String(currentValue)}
                      onValueChange={(value) =>
                        updateNodeProperty(selectedNode.id, prop.name, value)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs md:h-9 md:text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {prop.options.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            className="text-xs md:text-sm"
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {prop.type === 'boolean' && (
                    <div className="flex items-center gap-2">
                      <Switch
                        id={prop.name}
                        checked={Boolean(currentValue)}
                        onCheckedChange={(checked) =>
                          updateNodeProperty(selectedNode.id, prop.name, checked)
                        }
                      />
                      <Label htmlFor={prop.name} className="text-[10px] text-gray-500 md:text-xs">
                        {currentValue ? 'Enabled' : 'Disabled'}
                      </Label>
                    </div>
                  )}

                  {prop.description && prop.type !== 'text' && prop.type !== 'textarea' && (
                    <p className="text-[9px] text-gray-500 md:hidden md:text-[10px]">
                      {prop.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Connections Info */}
        <div className="border-t border-gray-200 pt-3 md:pt-4 dark:border-gray-800">
          <h4 className="mb-2 text-xs font-medium text-gray-700 md:text-sm dark:text-gray-300">
            Allowed Connections
          </h4>
          <div className="flex flex-wrap gap-1">
            {serviceDefinition.allowedConnections.map((connId) => (
              <span
                key={connId}
                className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] uppercase text-gray-600 md:px-2 md:text-[10px] dark:bg-gray-800 dark:text-gray-400"
              >
                {connId}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="shrink-0 border-t border-gray-200 p-3 md:p-4 dark:border-gray-800">
        <Button
          variant="destructive"
          size="sm"
          className="h-8 w-full gap-2 text-xs md:h-9 md:text-sm"
          onClick={() => {
            removeNode(selectedNode.id);
            selectNode(null);
          }}
        >
          <Trash2 className="h-3.5 w-3.5 md:h-4 md:w-4" />
          Remove Service
        </Button>
      </div>
    </motion.div>
  );

  return (
    <AnimatePresence mode="wait">
      {isMobile ? (
        <>
          {/* Mobile overlay backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50"
            onClick={handleClose}
          />
          {panelContent}
        </>
      ) : (
        panelContent
      )}
    </AnimatePresence>
  );
}
