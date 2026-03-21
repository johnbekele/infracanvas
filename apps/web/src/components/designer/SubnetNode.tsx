import { memo } from 'react';
import { NodeProps, NodeResizeControl, Handle, Position } from 'reactflow';
import { motion } from 'framer-motion';
import { Globe, Shield, Maximize2 } from 'lucide-react';
import { ServiceNodeData } from '@/lib/stores/designer-store';
import { useDesignerStore } from '@/lib/stores/designer-store';

const controlStyle = {
  background: 'transparent',
  border: 'none',
};

function SubnetNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId, removeNodeWithChildren } = useDesignerStore();
  const isSelected = selected || selectedNodeId === id;

  const isPublic = data?.serviceId === 'public-subnet';
  const Icon = isPublic ? Globe : Shield;

  // Color scheme based on subnet type
  const colors = isPublic
    ? {
        bg: 'bg-green-50/50 dark:bg-green-950/30',
        bgHover: 'bg-green-50/70 dark:bg-green-950/40',
        border: 'border-green-400 dark:border-green-600',
        borderSelected: 'border-green-500',
        icon: 'bg-green-500',
        iconColor: 'text-green-500',
        text: 'text-green-700 dark:text-green-400',
        hint: 'text-green-500 dark:text-green-500',
        hintIcon: 'text-green-400 dark:text-green-600',
      }
    : {
        bg: 'bg-orange-50/50 dark:bg-orange-950/30',
        bgHover: 'bg-orange-50/70 dark:bg-orange-950/40',
        border: 'border-orange-400 dark:border-orange-600',
        borderSelected: 'border-orange-500',
        icon: 'bg-orange-500',
        iconColor: 'text-orange-500',
        text: 'text-orange-700 dark:text-orange-400',
        hint: 'text-orange-500 dark:text-orange-500',
        hintIcon: 'text-orange-400 dark:text-orange-600',
      };

  const subnetName = data?.properties?.subnetName || (isPublic ? 'Public Subnet' : 'Private Subnet');
  const cidrBlock = data?.properties?.cidrBlock || (isPublic ? '10.0.1.0/24' : '10.0.10.0/24');

  return (
    <div
      className="relative w-full h-full min-w-[200px] min-h-[150px]"
      style={{ zIndex: isSelected ? 0 : -1 }}
      onClick={(e) => {
        e.stopPropagation();
        selectNode(id);
      }}
    >
      {/* Resize Control - bottom right corner */}
      <NodeResizeControl
        style={controlStyle}
        minWidth={200}
        minHeight={150}
        position="bottom-right"
      >
        <div className={`w-3 h-3 flex items-center justify-center ${isSelected ? 'opacity-100' : 'opacity-0'} transition-opacity cursor-se-resize`}>
          <Maximize2
            className={`w-2.5 h-2.5 ${colors.iconColor}`}
            style={{ transform: 'rotate(90deg)' }}
          />
        </div>
      </NodeResizeControl>

      {/* Subnet Header - positioned above the container */}
      <div className="absolute -top-7 left-0 flex items-center gap-2 pointer-events-none">
        <div className={`w-5 h-5 rounded ${colors.icon} flex items-center justify-center shadow-sm`}>
          <Icon className="w-3 h-3 text-white" />
        </div>
        <span className={`text-xs font-semibold ${colors.text}`}>
          {subnetName}
        </span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
          {cidrBlock}
        </span>
      </div>

      {/* Container Area - this is the drop zone */}
      <div
        className={`
          w-full h-full
          border-2 border-dashed rounded-lg
          transition-all duration-200
          ${isSelected
            ? `${colors.borderSelected} ${colors.bgHover}`
            : `${colors.border} ${colors.bg}`
          }
        `}
      >
        {/* Drop zone hint */}
        <div className="absolute inset-2 flex items-center justify-center pointer-events-none">
          <div className={`
            text-center transition-opacity duration-200
            ${isSelected ? 'opacity-80' : 'opacity-40'}
          `}>
            <Icon className={`w-8 h-8 mx-auto ${colors.hintIcon} mb-1`} />
            <p className={`text-xs font-medium ${colors.hint}`}>
              {isPublic ? 'Drop ALB, NAT, EC2' : 'Drop ECS, RDS, Cache'}
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
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center shadow-md hover:bg-red-600 transition-all z-20"
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
          layoutId={`subnet-selection-${id}`}
          className={`absolute -inset-0.5 border-2 ${colors.borderSelected} rounded-lg pointer-events-none`}
          initial={false}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}

      {/* Subnet type badge */}
      <div className={`
        absolute bottom-2 right-2 px-2 py-0.5 rounded text-[9px] font-medium pointer-events-none
        ${isPublic
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300'
        }
      `}>
        {isPublic ? 'PUBLIC' : 'PRIVATE'}
      </div>

      {/* Hidden handles for edge connections - disabled to not interfere */}
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" isConnectable={false} />
    </div>
  );
}

export const SubnetNode = memo(SubnetNodeComponent);
