import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Settings, Trash2, Info } from 'lucide-react';
import { useDesignerStore } from '@/lib/stores/designer-store';
import { getServiceById } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
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
      className={`
        bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 flex flex-col
        ${isMobile
          ? 'fixed inset-y-0 right-0 w-[90vw] max-w-[320px] z-50 shadow-2xl'
          : 'w-72 md:w-80 h-full'
        }
      `}
    >
      {/* Header */}
      <div className="p-3 md:p-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: selectedNode.data.color }}
            >
              <Settings className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm md:text-base text-gray-900 dark:text-white truncate">
                {selectedNode.data.serviceName}
              </h3>
              <p className="text-[10px] md:text-xs text-gray-500 capitalize">
                {selectedNode.data.category}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleClose}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Properties - Scrollable */}
      <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-4">
        <div>
          <h4 className="text-xs md:text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 md:mb-3">
            Configuration
          </h4>

          <div className="space-y-3 md:space-y-4">
            {serviceDefinition.properties.map((prop) => {
              const currentValue =
                selectedNode.data.properties[prop.name] ?? prop.default;

              return (
                <div key={prop.name} className="space-y-1 md:space-y-1.5">
                  <Label htmlFor={prop.name} className="text-[11px] md:text-xs flex items-center gap-1">
                    {prop.label}
                    {prop.required && (
                      <span className="text-red-500">*</span>
                    )}
                    {prop.description && (
                      <span className="text-gray-400 hidden md:inline" title={prop.description}>
                        <Info className="w-3 h-3" />
                      </span>
                    )}
                  </Label>

                  {prop.type === 'text' && (
                    <Input
                      id={prop.name}
                      value={String(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(
                          selectedNode.id,
                          prop.name,
                          e.target.value
                        )
                      }
                      placeholder={prop.description}
                      className="h-8 md:h-9 text-xs md:text-sm"
                    />
                  )}

                  {prop.type === 'textarea' && (
                    <Textarea
                      id={prop.name}
                      value={String(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(
                          selectedNode.id,
                          prop.name,
                          e.target.value
                        )
                      }
                      placeholder={prop.description}
                      className="text-xs md:text-sm min-h-[60px] resize-none"
                      rows={3}
                    />
                  )}

                  {prop.type === 'number' && (
                    <Input
                      id={prop.name}
                      type="number"
                      value={Number(currentValue)}
                      onChange={(e) =>
                        updateNodeProperty(
                          selectedNode.id,
                          prop.name,
                          Number(e.target.value)
                        )
                      }
                      className="h-8 md:h-9 text-xs md:text-sm"
                    />
                  )}

                  {prop.type === 'select' && prop.options && (
                    <Select
                      value={String(currentValue)}
                      onValueChange={(value) =>
                        updateNodeProperty(selectedNode.id, prop.name, value)
                      }
                    >
                      <SelectTrigger className="h-8 md:h-9 text-xs md:text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {prop.options.map((option) => (
                          <SelectItem key={option.value} value={option.value} className="text-xs md:text-sm">
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
                          updateNodeProperty(
                            selectedNode.id,
                            prop.name,
                            checked
                          )
                        }
                      />
                      <Label htmlFor={prop.name} className="text-[10px] md:text-xs text-gray-500">
                        {currentValue ? 'Enabled' : 'Disabled'}
                      </Label>
                    </div>
                  )}

                  {prop.description && prop.type !== 'text' && prop.type !== 'textarea' && (
                    <p className="text-[9px] md:text-[10px] text-gray-500 md:hidden">
                      {prop.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Connections Info */}
        <div className="pt-3 md:pt-4 border-t border-gray-200 dark:border-gray-800">
          <h4 className="text-xs md:text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Allowed Connections
          </h4>
          <div className="flex flex-wrap gap-1">
            {serviceDefinition.allowedConnections.map((connId) => (
              <span
                key={connId}
                className="px-1.5 md:px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[9px] md:text-[10px] rounded-full uppercase"
              >
                {connId}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-3 md:p-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
        <Button
          variant="destructive"
          size="sm"
          className="w-full gap-2 h-8 md:h-9 text-xs md:text-sm"
          onClick={() => {
            removeNode(selectedNode.id);
            selectNode(null);
          }}
        >
          <Trash2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
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
            className="fixed inset-0 bg-black/50 z-40"
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
