import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from 'reactflow';
import { X } from 'lucide-react';
import { useDesignerStore } from '@/lib/stores/designer-store';

function DeletableEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  selected,
}: EdgeProps) {
  const [isHovered, setIsHovered] = useState(false);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  const onEdgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const { onEdgesChange } = useDesignerStore.getState();
    onEdgesChange([{ type: 'remove', id }]);
  };

  const showDeleteButton = selected || isHovered;

  // Dynamic colors based on state
  const strokeColor = selected ? '#8b5cf6' : isHovered ? '#a78bfa' : '#22c55e';
  const strokeWidth = selected || isHovered ? 3 : 2;

  return (
    <>
      {/* Invisible wider path for easier hover detection */}
      <path
        d={edgePath}
        fill="none"
        strokeWidth={20}
        stroke="transparent"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{ cursor: 'pointer' }}
      />

      {/* Animated gradient edge */}
      <defs>
        <linearGradient id={`edge-gradient-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <marker
          id={`arrow-${id}`}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            fill={strokeColor}
            className="transition-colors duration-150"
          />
        </marker>
      </defs>

      {/* Actual visible edge */}
      <BaseEdge
        path={edgePath}
        markerEnd={`url(#arrow-${id})`}
        style={{
          ...style,
          strokeWidth,
          stroke: selected || isHovered ? strokeColor : `url(#edge-gradient-${id})`,
          transition: 'stroke 0.15s, stroke-width 0.15s',
        }}
      />

      {/* Flow animation dots */}
      {!selected && !isHovered && (
        <circle r="3" fill="#22c55e">
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {/* Delete button */}
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {showDeleteButton && (
            <button
              onClick={onEdgeClick}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-500 text-white shadow-lg transition-all hover:scale-110 hover:bg-red-600"
              title="Delete connection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const DeletableEdge = memo(DeletableEdgeComponent);
