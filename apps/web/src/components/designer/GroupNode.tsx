import { memo } from 'react';
import { type NodeProps, NodeResizeControl, Handle, Position } from 'reactflow';
import { motion } from 'framer-motion';
import { Maximize2 } from 'lucide-react';
import { getServiceById } from '@infracanvas/core';
import { useDesignerStore, type ServiceNodeData } from '@/lib/stores/designer-store';
import { CONTAINER_DEFAULT_SIZE } from '@/lib/designer/containment';
import { iconFor } from './service-icons';

const controlStyle = { background: 'transparent', border: 'none' };

/** Properties that name a group, in the order a label should prefer them. */
const NAME_PROPERTIES = [
  'vpcName',
  'subnetName',
  'zoneName',
  'clusterName',
  'groupName',
  'regionName',
  'accountName',
  'environmentName',
  'deploymentName',
  'fleetName',
  'stateMachineName',
  'label',
];

/** Shown beside the name when the group has one, because it is what a reader checks next. */
const SECONDARY_PROPERTIES = ['cidrBlock', 'regionName', 'stateMachineType'];

function firstProperty(
  properties: ServiceNodeData['properties'],
  names: string[]
): string | undefined {
  for (const name of names) {
    const value = properties?.[name];
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return undefined;
}

/**
 * Every box that holds other nodes: the AWS architecture groups.
 *
 * One component for all of them, driven by the `group` style the catalogue
 * declares. There were three of these before -- one for the VPC, one for the two
 * subnets, one for clusters and zones -- and because each carried its own
 * Tailwind palette, the canvas ended up with a violet VPC, an orange private
 * subnet and a purple zone, none of which is what AWS draws. Reading the style
 * from the catalogue means the border colour, the dash and the fill are stated
 * once, next to the service they belong to.
 */
function GroupNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId, removeNodeWithChildren, getChildNodes } = useDesignerStore();
  const isSelected = selected || selectedNodeId === id;
  // The hint sits where the first child lands, so it reads as a label for that
  // child the moment there is one. Hence: only while empty.
  const isEmpty = getChildNodes(id).length === 0;

  const service = getServiceById(data.serviceId);
  const style = service?.group ?? { stroke: '#5A6C86', border: 'solid' as const, showIcon: true };
  const Icon = iconFor(service?.icon);

  const name = firstProperty(data.properties, NAME_PROPERTIES) ?? data.serviceName ?? service?.name;
  const secondary = firstProperty(data.properties, SECONDARY_PROPERTIES);

  const fallback = CONTAINER_DEFAULT_SIZE[data.serviceId];
  const minWidth = Math.min(240, fallback?.width ?? 240);
  const minHeight = Math.min(180, fallback?.height ?? 180);

  return (
    <div
      className="relative h-full w-full"
      style={{ minWidth, minHeight, zIndex: isSelected ? 0 : -1 }}
      onClick={(event) => {
        event.stopPropagation();
        selectNode(id);
      }}
    >
      <NodeResizeControl
        style={controlStyle}
        minWidth={minWidth}
        minHeight={minHeight}
        position="bottom-right"
      >
        <div
          className={`flex h-3 w-3 cursor-se-resize items-center justify-center transition-opacity ${
            isSelected ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <Maximize2 className="h-2.5 w-2.5" style={{ rotate: '90deg', color: style.stroke }} />
        </div>
      </NodeResizeControl>

      <div
        className="absolute inset-0 overflow-hidden rounded-md transition-all duration-200"
        style={{
          borderWidth: 2,
          borderStyle: style.border,
          borderColor: style.stroke,
          outline: isSelected ? `2px solid ${style.stroke}` : undefined,
          outlineOffset: 2,
        }}
      >
        {/* A separate layer so the wash can be dimmed on a dark canvas without
            taking the label and the children down with it. */}
        {style.fill && (
          <div
            className="absolute inset-0 dark:opacity-[0.14]"
            style={{ backgroundColor: style.fill }}
          />
        )}
      </div>

      <div className="pointer-events-none absolute left-0 top-0 flex max-w-full items-center gap-1.5 px-2 py-2">
        {style.showIcon !== false && (
          <div
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded shadow-sm"
            style={{ backgroundColor: style.stroke }}
          >
            <Icon className="h-3 w-3 text-white" />
          </div>
        )}
        <span className="truncate text-xs font-semibold" style={{ color: style.stroke }}>
          {name}
        </span>
        {secondary && secondary !== name && (
          <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {secondary}
          </span>
        )}
      </div>

      {isEmpty && service?.description && (
        <div className="pointer-events-none absolute inset-x-3 bottom-0 top-9 flex items-center justify-center">
          <p
            className="text-center text-[11px] font-medium opacity-60"
            style={{ color: style.stroke }}
          >
            {service.description}
          </p>
        </div>
      )}

      {isSelected && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          whileHover={{ scale: 1.1 }}
          animate={{ opacity: 1 }}
          className="absolute -right-2 -top-2 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow-md transition-all hover:bg-red-600"
          onClick={(event) => {
            event.stopPropagation();
            removeNodeWithChildren(id);
          }}
        >
          ×
        </motion.button>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="pointer-events-none opacity-0"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="pointer-events-none opacity-0"
        isConnectable={false}
      />
    </div>
  );
}

export const GroupNode = memo(GroupNodeComponent);
