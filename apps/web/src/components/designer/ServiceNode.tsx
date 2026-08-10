import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { motion } from 'framer-motion';

import { getServiceById } from '@infracanvas/core';
import { type ServiceNodeData } from '@/lib/stores/designer-store';
import { iconFor } from './service-icons';
import { useDesignerStore } from '@/lib/stores/designer-store';

function ServiceNodeComponent({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const { selectNode, selectedNodeId } = useDesignerStore();
  // Indexed by the icon the catalog declares. Indexing by `serviceId`
  // silently gave every node the same fallback glyph.
  const Icon = iconFor(getServiceById(data.serviceId)?.icon);

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
      className="group relative cursor-pointer"
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
        className={`w-36 rounded-xl border-2 bg-white shadow-lg transition-all duration-200 dark:bg-gray-800 ${
          isSelected
            ? 'border-violet-500 shadow-xl shadow-violet-500/25'
            : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
        } `}
      >
        {/* Service Icon Header */}
        <div
          className="relative flex items-center justify-center rounded-t-[10px] p-3"
          style={{ backgroundColor: data.color + '20' }}
        >
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{ backgroundColor: data.color }}
          >
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>

        {/* Service Name */}
        <div className="p-2 text-center">
          <p className="truncate text-xs font-semibold text-gray-900 dark:text-white">
            {data.serviceName}
          </p>
          <p className="text-[10px] capitalize text-gray-500 dark:text-gray-400">{data.category}</p>
        </div>

        {/* Connection hint on hover */}
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
          <span className="rounded bg-gray-800 px-2 py-0.5 text-[9px] text-white shadow">
            <span className="text-blue-400">●</span> In &nbsp;
            <span className="text-green-400">●</span> Out
          </span>
        </div>

        {/* Selection Indicator */}
        {isSelected && (
          <motion.div
            layoutId="node-selection"
            className="pointer-events-none absolute -inset-1 rounded-xl border-2 border-violet-500"
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
        className={`absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 ${isSelected ? 'opacity-100' : ''} `}
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
