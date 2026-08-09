import { memo } from 'react';
import { type NodeProps, NodeResizeControl, Handle, Position } from 'reactflow';
import { motion } from 'framer-motion';
import { Network, Maximize2 } from 'lucide-react';
import { type ServiceNodeData } from '@/lib/stores/designer-store';
import { useDesignerStore } from '@/lib/stores/designer-store';

const controlStyle = {
  background: 'transparent',
  border: 'none',
};

function VpcEnvironmentNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId, removeNodeWithChildren } = useDesignerStore();
  const isSelected = selected || selectedNodeId === id;

  const vpcName = data?.properties?.vpcName || 'VPC';
  const cidrBlock = data?.properties?.cidrBlock || '10.0.0.0/16';

  return (
    <div
      className="relative h-full min-h-[300px] w-full min-w-[400px]"
      style={{ zIndex: isSelected ? 0 : -2 }}
      onClick={(e) => {
        e.stopPropagation();
        selectNode(id);
      }}
    >
      {/* Resize Control - bottom right corner */}
      <NodeResizeControl
        style={controlStyle}
        minWidth={400}
        minHeight={300}
        position="bottom-right"
      >
        <div
          className={`flex h-4 w-4 items-center justify-center ${isSelected ? 'opacity-100' : 'opacity-0'} cursor-se-resize transition-opacity`}
        >
          <Maximize2 className="h-3 w-3 text-violet-500" style={{ transform: 'rotate(90deg)' }} />
        </div>
      </NodeResizeControl>

      {/* VPC Header - positioned above the container */}
      <div className="pointer-events-none absolute -top-8 left-0 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-600 shadow-sm">
          <Network className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">
          {vpcName}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {cidrBlock}
        </span>
      </div>

      {/* Container Area - this is the drop zone */}
      <div
        className={`h-full w-full rounded-xl border-2 border-dashed transition-all duration-200 ${
          isSelected
            ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-950/30'
            : 'border-violet-300 bg-violet-50/30 dark:border-violet-700 dark:bg-violet-950/20'
        } `}
      >
        {/* Drop zone hint */}
        <div className="pointer-events-none absolute inset-4 flex items-center justify-center">
          <div
            className={`text-center transition-opacity duration-200 ${isSelected ? 'opacity-70' : 'opacity-30'} `}
          >
            <Network className="mx-auto mb-2 h-10 w-10 text-violet-300 dark:text-violet-700" />
            <p className="text-sm font-medium text-violet-400 dark:text-violet-600">
              Drop subnets here
            </p>
            <p className="mt-1 text-xs text-violet-300 dark:text-violet-700">
              Public & Private Subnets
            </p>
          </div>
        </div>
      </div>

      {/* Delete Button */}
      {isSelected && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          whileHover={{ scale: 1.1 }}
          animate={{ opacity: 1 }}
          className="absolute -right-2 -top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-sm text-white shadow-md transition-all hover:bg-red-600"
          onClick={(e) => {
            e.stopPropagation();
            removeNodeWithChildren(id);
          }}
        >
          ×
        </motion.button>
      )}

      {/* Selection ring */}
      {isSelected && (
        <motion.div
          layoutId={`vpc-selection-${id}`}
          className="pointer-events-none absolute -inset-1 rounded-xl border-2 border-violet-500"
          initial={false}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}

      {/* VPC badge */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-violet-100 px-2 py-0.5 text-[9px] font-medium text-violet-700 dark:bg-violet-900 dark:text-violet-300">
        VPC
      </div>

      {/* Hidden handles for edge connections - disabled to not interfere */}
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

export const VpcEnvironmentNode = memo(VpcEnvironmentNodeComponent);
