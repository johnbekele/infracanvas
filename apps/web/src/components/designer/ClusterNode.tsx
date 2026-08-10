import { memo } from 'react';
import { type NodeProps, NodeResizeControl, Handle, Position } from 'reactflow';
import { motion } from 'framer-motion';
import { Boxes, Hexagon, LayoutGrid, Maximize2 } from 'lucide-react';
import { useDesignerStore, type ServiceNodeData } from '@/lib/stores/designer-store';

const controlStyle = { background: 'transparent', border: 'none' };

/**
 * Containers that group compute rather than define a network boundary.
 *
 * A cluster is the answer to "what shares capacity", and an availability zone is
 * the answer to "what fails together". Both are drawn as boxes because that is
 * what they are: nine services in a flat row cannot express either.
 */
const VARIANTS = {
  'ecs-cluster': {
    icon: Boxes,
    label: 'ECS Cluster',
    hint: 'Container services share this capacity',
    accent: 'orange',
  },
  'eks-cluster': {
    icon: Hexagon,
    label: 'EKS Cluster',
    hint: 'Workloads scheduled by Kubernetes',
    accent: 'blue',
  },
  'availability-zone': {
    icon: LayoutGrid,
    label: 'Availability Zone',
    hint: 'Everything here fails together',
    accent: 'purple',
  },
} as const;

const ACCENTS = {
  orange: {
    surface: 'bg-orange-50/40 dark:bg-orange-950/20',
    border: 'border-orange-300 dark:border-orange-700',
    borderSelected: 'border-orange-500',
    badge: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-400',
    muted: 'text-orange-400/70 dark:text-orange-600/70',
  },
  blue: {
    surface: 'bg-blue-50/40 dark:bg-blue-950/20',
    border: 'border-blue-300 dark:border-blue-700',
    borderSelected: 'border-blue-500',
    badge: 'bg-blue-500',
    text: 'text-blue-700 dark:text-blue-400',
    muted: 'text-blue-400/70 dark:text-blue-600/70',
  },
  purple: {
    surface: 'bg-purple-50/30 dark:bg-purple-950/20',
    border: 'border-purple-300 dark:border-purple-700',
    borderSelected: 'border-purple-500',
    badge: 'bg-purple-500',
    text: 'text-purple-700 dark:text-purple-400',
    muted: 'text-purple-400/70 dark:text-purple-600/70',
  },
} as const;

function ClusterNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId, removeNodeWithChildren } = useDesignerStore();
  const isSelected = selected || selectedNodeId === id;

  const variant = VARIANTS[data.serviceId as keyof typeof VARIANTS] ?? VARIANTS['ecs-cluster'];
  const colours = ACCENTS[variant.accent];
  const Icon = variant.icon;

  const name =
    data.properties?.clusterName ?? data.properties?.zoneName ?? data.serviceName ?? variant.label;

  return (
    <div
      className="relative h-full min-h-[150px] w-full min-w-[200px]"
      style={{ zIndex: isSelected ? 0 : -1 }}
      onClick={(event) => {
        event.stopPropagation();
        selectNode(id);
      }}
    >
      <NodeResizeControl
        style={controlStyle}
        minWidth={200}
        minHeight={150}
        position="bottom-right"
      >
        <div
          className={`flex h-3 w-3 cursor-se-resize items-center justify-center transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0'}`}
        >
          <Maximize2 className={`h-2.5 w-2.5 ${colours.text}`} style={{ rotate: '90deg' }} />
        </div>
      </NodeResizeControl>

      <div className="pointer-events-none absolute -top-7 left-0 flex items-center gap-2">
        <div
          className={`flex h-5 w-5 items-center justify-center rounded ${colours.badge} shadow-sm`}
        >
          <Icon className="h-3 w-3 text-white" />
        </div>
        <span className={`text-xs font-semibold ${colours.text}`}>{String(name)}</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {variant.label}
        </span>
      </div>

      <div
        className={`h-full w-full rounded-lg border-2 border-dashed transition-all duration-200 ${
          isSelected
            ? `${colours.borderSelected} ${colours.surface}`
            : `${colours.border} ${colours.surface}`
        }`}
      >
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center">
          <p className={`text-[11px] font-medium ${colours.muted}`}>{variant.hint}</p>
        </div>
      </div>

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

export const ClusterNode = memo(ClusterNodeComponent);
