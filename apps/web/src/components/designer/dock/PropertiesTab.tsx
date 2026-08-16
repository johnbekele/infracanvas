import { useMemo } from 'react';
import { Info, Trash2 } from 'lucide-react';

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
import { useDesignerStore } from '@/lib/stores/designer-store';
import { ZONE_PROPERTY, getServiceById, zoneNameOf } from '@infracanvas/core';

import { NodeEvidence } from '../NodeEvidence';

/**
 * Configuration for whatever is selected on the canvas.
 *
 * A tab rather than a panel that appears over the others: the properties of a
 * node and the cost of the architecture are answers to different questions about
 * the same drawing, and stacking two panels down the right edge left neither
 * enough room to be read.
 */
export function PropertiesTab() {
  const { nodes, selectedNodeId, selectNode, updateNodeProperty, removeNode } = useDesignerStore();

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  const definition = useMemo(
    () => (selectedNode ? getServiceById(selectedNode.data.serviceId) : null),
    [selectedNode]
  );

  // The zone a node is drawn in decides its zone, so offering the choice again
  // here would let the panel disagree with both the canvas and the export.
  const zoneName = useMemo(
    () => (selectedNode ? zoneNameOf(selectedNode, nodes) : undefined),
    [selectedNode, nodes]
  );

  if (!selectedNode || !definition) {
    return (
      <div className="flex-1 p-3">
        <p className="text-[11px] text-gray-500">
          Select a service on the canvas to configure it. Its properties change what the generated
          code declares, and what every figure under Simulation is computed from.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <div className="flex items-center gap-2">
          <div
            className="h-6 w-6 shrink-0 rounded-md"
            style={{ backgroundColor: selectedNode.data.color }}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
              {selectedNode.data.serviceName}
            </p>
            <p className="text-[10px] capitalize text-gray-500">{selectedNode.data.category}</p>
          </div>
        </div>

        <NodeEvidence data={selectedNode.data} />

        <div className="space-y-3">
          {definition.properties.map((property) => {
            const value = selectedNode.data.properties[property.name] ?? property.default;

            if (property.name === ZONE_PROPERTY && zoneName) {
              return (
                <div key={property.name} className="space-y-1">
                  <Label className="text-[11px]">{property.label}</Label>
                  <Input value={zoneName} readOnly disabled className="h-8 text-xs" />
                  <p className="text-[9px] text-gray-500">
                    Taken from the availability zone this sits inside.
                  </p>
                </div>
              );
            }

            return (
              <div key={property.name} className="space-y-1">
                <Label htmlFor={property.name} className="flex items-center gap-1 text-[11px]">
                  {property.label}
                  {property.required && <span className="text-red-500">*</span>}
                  {property.description && (
                    <span className="text-gray-400" title={property.description}>
                      <Info className="h-3 w-3" />
                    </span>
                  )}
                </Label>

                {property.type === 'text' && (
                  <Input
                    id={property.name}
                    value={String(value)}
                    onChange={(event) =>
                      updateNodeProperty(selectedNode.id, property.name, event.target.value)
                    }
                    placeholder={property.description}
                    className="h-8 text-xs"
                  />
                )}

                {property.type === 'textarea' && (
                  <Textarea
                    id={property.name}
                    value={String(value)}
                    onChange={(event) =>
                      updateNodeProperty(selectedNode.id, property.name, event.target.value)
                    }
                    placeholder={property.description}
                    className="min-h-[60px] resize-none text-xs"
                    rows={3}
                  />
                )}

                {property.type === 'number' && (
                  <Input
                    id={property.name}
                    type="number"
                    value={Number(value)}
                    onChange={(event) =>
                      updateNodeProperty(selectedNode.id, property.name, Number(event.target.value))
                    }
                    className="h-8 text-xs"
                  />
                )}

                {property.type === 'select' && property.options && (
                  <Select
                    value={String(value)}
                    onValueChange={(next) =>
                      updateNodeProperty(selectedNode.id, property.name, next)
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {property.options.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {property.type === 'boolean' && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id={property.name}
                      checked={Boolean(value)}
                      onCheckedChange={(checked) =>
                        updateNodeProperty(selectedNode.id, property.name, checked)
                      }
                    />
                    <Label htmlFor={property.name} className="text-[10px] text-gray-500">
                      {value ? 'Enabled' : 'Disabled'}
                    </Label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
          <h4 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
            Allowed connections
          </h4>
          <div className="flex flex-wrap gap-1">
            {definition.allowedConnections.map((id) => (
              <span
                key={id}
                className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-gray-200 p-3 dark:border-gray-800">
        <Button
          variant="destructive"
          size="sm"
          className="h-8 w-full gap-2 text-xs"
          onClick={() => {
            removeNode(selectedNode.id);
            selectNode(null);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove service
        </Button>
      </div>
    </div>
  );
}
