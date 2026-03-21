import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { motion } from 'framer-motion';
import {
  Server, Database, Globe, Shield, Zap, Bell,
  Inbox, GitBranch, Users, Table, Network, Box
} from 'lucide-react';
import { ServiceNodeData } from '@/lib/stores/designer-store';
import { useDesignerStore } from '@/lib/stores/designer-store';

const iconMap: Record<string, React.ElementType> = {
  server: Server,
  database: Database,
  globe: Globe,
  shield: Shield,
  zap: Zap,
  bell: Bell,
  inbox: Inbox,
  'git-branch': GitBranch,
  users: Users,
  table: Table,
  network: Network,
  container: Box,
};

function ServiceNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId } = useDesignerStore();
  const Icon = iconMap[data.serviceId] || iconMap.server;

  const isSelected = selected || selectedNodeId === id;

  // Common handle base styles
  const handleBase = `
    !w-3.5 !h-3.5 !border-2 !border-white
    hover:!scale-125 transition-all duration-150
    !rounded-full shadow-md
  `;

  // Input handles (target) - Blue - where requests/data come IN
  const inputHandleStyle = `${handleBase} !bg-blue-500 hover:!bg-blue-600`;

  // Output handles (source) - Green - where requests/data go OUT
  const outputHandleStyle = `${handleBase} !bg-green-500 hover:!bg-green-600`;

  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="relative group cursor-pointer"
      style={{ zIndex: isSelected ? 100 : 10 }}
      onClick={() => selectNode(id)}
    >
      {/* INPUT HANDLES - Left & Top (Blue) - Where data/requests come IN */}

      {/* Left Input - Primary input */}
      <Handle
        type="target"
        position={Position.Left}
        id="input-left"
        className={inputHandleStyle}
        style={{ top: '50%' }}
        isConnectable={true}
        isConnectableEnd={true}
      />

      {/* Top Input - Secondary input */}
      <Handle
        type="target"
        position={Position.Top}
        id="input-top"
        className={inputHandleStyle}
        style={{ left: '50%' }}
        isConnectable={true}
        isConnectableEnd={true}
      />

      {/* Node Card */}
      <div
        className={`
          w-36 bg-white dark:bg-gray-800 rounded-xl border-2 shadow-lg
          transition-all duration-200
          ${isSelected
            ? 'border-violet-500 shadow-violet-500/25 shadow-xl'
            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
          }
        `}
      >
        {/* Service Icon Header */}
        <div
          className="p-3 rounded-t-[10px] flex items-center justify-center relative"
          style={{ backgroundColor: data.color + '20' }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: data.color }}
          >
            <Icon className="w-5 h-5 text-white" />
          </div>
        </div>

        {/* Service Name */}
        <div className="p-2 text-center">
          <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">
            {data.serviceName}
          </p>
          <p className="text-[10px] text-gray-500 dark:text-gray-400 capitalize">
            {data.category}
          </p>
        </div>

        {/* Connection hint on hover */}
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
          <span className="text-[9px] bg-gray-800 text-white px-2 py-0.5 rounded shadow">
            <span className="text-blue-400">●</span> In &nbsp;
            <span className="text-green-400">●</span> Out
          </span>
        </div>

        {/* Selection Indicator */}
        {isSelected && (
          <motion.div
            layoutId="node-selection"
            className="absolute -inset-1 border-2 border-violet-500 rounded-xl pointer-events-none"
            initial={false}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
          />
        )}
      </div>

      {/* OUTPUT HANDLES - Right & Bottom (Green) - Where data/requests go OUT */}

      {/* Right Output - Primary output */}
      <Handle
        type="source"
        position={Position.Right}
        id="output-right"
        className={outputHandleStyle}
        style={{ top: '50%' }}
        isConnectable={true}
        isConnectableStart={true}
      />

      {/* Bottom Output - Secondary output */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="output-bottom"
        className={outputHandleStyle}
        style={{ left: '50%' }}
        isConnectable={true}
        isConnectableStart={true}
      />

      {/* Delete Button (on hover) */}
      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        whileHover={{ scale: 1.1 }}
        animate={{ opacity: isSelected ? 1 : 0 }}
        className={`
          absolute -top-2 -right-2 w-5 h-5 rounded-full
          bg-red-500 text-white text-xs flex items-center justify-center
          shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-10
          ${isSelected ? 'opacity-100' : ''}
        `}
        onClick={(e) => {
          e.stopPropagation();
          const { removeNode } = useDesignerStore.getState();
          removeNode(id);
        }}
      >
        ×
      </motion.button>
    </motion.div>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);
