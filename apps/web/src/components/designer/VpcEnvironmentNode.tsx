import { memo } from 'react';
import { NodeProps, NodeResizeControl, Handle, Position } from 'reactflow';
import { motion } from 'framer-motion';
import { Network, Maximize2 } from 'lucide-react';
import { ServiceNodeData } from '@/lib/stores/designer-store';
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
      className="relative w-full h-full min-w-[400px] min-h-[300px]"
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
        <div className={`w-4 h-4 flex items-center justify-center ${isSelected ? 'opacity-100' : 'opacity-0'} transition-opacity cursor-se-resize`}>
          <Maximize2
            className="w-3 h-3 text-violet-500"
            style={{ transform: 'rotate(90deg)' }}
          />
        </div>
      </NodeResizeControl>

      {/* VPC Header - positioned above the container */}
      <div className="absolute -top-8 left-0 flex items-center gap-2 pointer-events-none">
        <div className="w-6 h-6 rounded-md bg-violet-600 flex items-center justify-center shadow-sm">
          <Network className="w-4 h-4 text-white" />
        </div>
        <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">
          {vpcName}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
          {cidrBlock}
        </span>
      </div>

      {/* Container Area - this is the drop zone */}
      <div
        className={`
          w-full h-full
          border-2 border-dashed rounded-xl
          transition-all duration-200
          ${isSelected
            ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-950/30'
            : 'border-violet-300 dark:border-violet-700 bg-violet-50/30 dark:bg-violet-950/20'
          }
        `}
      >
        {/* Drop zone hint */}
        <div className="absolute inset-4 flex items-center justify-center pointer-events-none">
          <div className={`
            text-center transition-opacity duration-200
            ${isSelected ? 'opacity-70' : 'opacity-30'}
          `}>
            <Network className="w-10 h-10 mx-auto text-violet-300 dark:text-violet-700 mb-2" />
            <p className="text-sm text-violet-400 dark:text-violet-600 font-medium">
              Drop subnets here
            </p>
            <p className="text-xs text-violet-300 dark:text-violet-700 mt-1">
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
          className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 text-white text-sm flex items-center justify-center shadow-md hover:bg-red-600 transition-all z-20"
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
          className="absolute -inset-1 border-2 border-violet-500 rounded-xl pointer-events-none"
          initial={false}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}

      {/* VPC badge */}
      <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded text-[9px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300 pointer-events-none">
        VPC
      </div>

      {/* Hidden handles for edge connections - disabled to not interfere */}
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" isConnectable={false} />
    </div>
  );
}

export const VpcEnvironmentNode = memo(VpcEnvironmentNodeComponent);
