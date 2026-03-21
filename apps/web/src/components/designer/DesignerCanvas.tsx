import { useCallback, useRef, useState, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  ConnectionLineType,
  ConnectionMode,
  Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Layers, X, ArrowRight } from 'lucide-react';

import { useDesignerStore, ServiceNodeData } from '@/lib/stores/designer-store';
import { AWSService, canConnect } from '@infracanvas/core';
import { ServiceNode } from './ServiceNode';
import { VpcEnvironmentNode } from './VpcEnvironmentNode';
import { SubnetNode } from './SubnetNode';
import { ServicePalette } from './ServicePalette';
import { PropertiesPanel } from './PropertiesPanel';
import { CodePanel } from './CodePanel';
import { DesignerToolbar } from './DesignerToolbar';
import { DeletableEdge } from './DeletableEdge';
import { Button } from '@/components/ui/button';

const nodeTypes = {
  serviceNode: ServiceNode,
  vpcEnvironment: VpcEnvironmentNode,
  subnet: SubnetNode,
};

const edgeTypes = {
  deletable: DeletableEdge,
};

let nodeId = 0;
const getNodeId = () => `node_${nodeId++}`;

function DesignerCanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const [isMobile, setIsMobile] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    selectNode,
  } = useDesignerStore();

  // Check for mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) {
        setShowPalette(false);
      }
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const onDragStart = useCallback(
    (event: React.DragEvent, service: AWSService) => {
      event.dataTransfer.setData('application/reactflow', JSON.stringify(service));
      event.dataTransfer.effectAllowed = 'move';
    },
    []
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Helper to determine node type based on service
  const getNodeType = (service: AWSService): string => {
    if (service.id === 'vpc-environment') return 'vpcEnvironment';
    if (service.id === 'public-subnet' || service.id === 'private-subnet') return 'subnet';
    return 'serviceNode';
  };

  // Helper to get absolute position of a node (accounting for parent nesting)
  const getAbsolutePosition = useCallback(
    (node: Node<ServiceNodeData>): { x: number; y: number } => {
      let x = node.position.x;
      let y = node.position.y;

      // If node has a parent, add parent's position recursively
      if (node.parentNode) {
        const parent = nodes.find((n) => n.id === node.parentNode);
        if (parent) {
          const parentPos = getAbsolutePosition(parent);
          x += parentPos.x;
          y += parentPos.y;
        }
      }

      return { x, y };
    },
    [nodes]
  );

  // Helper to find container node at drop position
  const findContainerAtPosition = useCallback(
    (flowPosition: { x: number; y: number }) => {
      // Find container nodes (VPC or subnet) at the drop position
      // Check from innermost (subnets) to outermost (VPCs)
      const containerNodes = nodes.filter(
        (n) => n.type === 'vpcEnvironment' || n.type === 'subnet'
      );

      // Sort by depth - subnets (nested) should be checked first
      const sortedContainers = containerNodes.sort((a, b) => {
        // Prioritize nodes with parents (nested deeper)
        const aDepth = a.parentNode ? 1 : 0;
        const bDepth = b.parentNode ? 1 : 0;
        return bDepth - aDepth;
      });

      for (const container of sortedContainers) {
        // Get the container's actual dimensions from style or defaults
        const width = (container.style?.width as number) ||
          (container.width) ||
          (container.type === 'vpcEnvironment' ? 500 : 220);
        const height = (container.style?.height as number) ||
          (container.height) ||
          (container.type === 'vpcEnvironment' ? 400 : 180);

        // Get absolute position accounting for parent nesting
        const absolutePos = getAbsolutePosition(container);

        const bounds = {
          left: absolutePos.x,
          right: absolutePos.x + width,
          top: absolutePos.y,
          bottom: absolutePos.y + height,
        };

        if (
          flowPosition.x >= bounds.left &&
          flowPosition.x <= bounds.right &&
          flowPosition.y >= bounds.top &&
          flowPosition.y <= bounds.bottom
        ) {
          return container;
        }
      }
      return null;
    },
    [nodes, getAbsolutePosition]
  );

  // Validate if service can be placed in container
  const validatePlacement = (service: AWSService, container: typeof nodes[0] | null): boolean => {
    // Subnets must go in VPC
    if (service.parentRequired === 'vpc-environment') {
      return container?.data.serviceId === 'vpc-environment';
    }

    // Check subnet placement rules
    if (service.subnetPlacement && container) {
      const containerServiceId = container.data.serviceId;
      if (containerServiceId === 'public-subnet') {
        return service.subnetPlacement.allowedInPublic;
      }
      if (containerServiceId === 'private-subnet') {
        return service.subnetPlacement.allowedInPrivate;
      }
    }

    return true;
  };

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const data = event.dataTransfer.getData('application/reactflow');
      if (!data) return;

      const service: AWSService = JSON.parse(data);

      // Get position relative to the canvas
      const flowPosition = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // Find container at drop position
      const container = findContainerAtPosition(flowPosition);

      // Validate placement
      if (!validatePlacement(service, container)) {
        // Show error or prevent drop
        console.warn(`Cannot place ${service.name} in this container`, {
          service: service.id,
          container: container?.data?.serviceId,
          subnetPlacement: service.subnetPlacement,
        });
        return;
      }

      // Debug: log successful placement
      if (container) {
        console.log(`Placing ${service.name} in ${container.data.serviceId}`, {
          position: flowPosition,
          containerId: container.id,
        });
      }

      // Determine node type
      const nodeType = getNodeType(service);

      // Initialize properties with defaults
      const properties: Record<string, string | number | boolean> = {};
      service.properties.forEach((prop) => {
        properties[prop.name] = prop.default;
      });

      // Calculate position relative to parent if nested
      let position = flowPosition;
      let parentNode: string | undefined;
      let extent: 'parent' | undefined;

      if (container) {
        // Only set parent for appropriate nesting:
        // - Subnets can be children of VPCs
        // - Services can be children of Subnets
        const isSubnetGoingIntoVpc =
          (service.id === 'public-subnet' || service.id === 'private-subnet') &&
          container.data.serviceId === 'vpc-environment';

        const isServiceGoingIntoSubnet =
          !service.isContainer &&
          (container.data.serviceId === 'public-subnet' || container.data.serviceId === 'private-subnet');

        if (isSubnetGoingIntoVpc || isServiceGoingIntoSubnet) {
          parentNode = container.id;
          extent = 'parent';
          // Make position relative to parent's absolute position
          const containerAbsPos = getAbsolutePosition(container);
          position = {
            x: flowPosition.x - containerAbsPos.x,
            y: flowPosition.y - containerAbsPos.y,
          };
          // Add some padding from edges
          position.x = Math.max(20, position.x);
          position.y = Math.max(40, position.y); // Account for header
        }
      }

      // Create the node
      const newNode: Parameters<typeof addNode>[0] = {
        id: getNodeId(),
        type: nodeType,
        position,
        parentNode,
        extent,
        data: {
          serviceId: service.id,
          serviceName: service.name,
          shortName: service.shortName,
          color: service.color,
          category: service.category,
          properties,
          nodeType: service.isContainer ? service.id as ServiceNodeData['nodeType'] : 'service',
          parentId: parentNode,
        },
      };

      // Add default size and zIndex for container nodes
      // zIndex: VPC = -2, Subnet = -1, Services = 0 (default)
      if (nodeType === 'vpcEnvironment') {
        const vpcNode = newNode as typeof newNode & { style: Record<string, unknown>; width: number; height: number; zIndex: number };
        vpcNode.style = { width: 500, height: 400 };
        vpcNode.width = 500;
        vpcNode.height = 400;
        vpcNode.zIndex = -2; // VPC at bottom layer
      } else if (nodeType === 'subnet') {
        const subnetNode = newNode as typeof newNode & { style: Record<string, unknown>; width: number; height: number; zIndex: number };
        subnetNode.style = { width: 220, height: 180 };
        subnetNode.width = 220;
        subnetNode.height = 180;
        subnetNode.zIndex = -1; // Subnet above VPC but below services
      }

      addNode(newNode);
    },
    [screenToFlowPosition, addNode, findContainerAtPosition, getAbsolutePosition]
  );

  const onConnectValidate = useCallback(
    (connection: { source: string | null; target: string | null; sourceHandle: string | null; targetHandle: string | null }) => {
      console.log('Connection attempt:', connection);

      if (!connection.source || !connection.target) {
        console.log('Rejected: missing source or target');
        return false;
      }

      // Prevent self-connections
      if (connection.source === connection.target) {
        console.log('Rejected: self-connection');
        return false;
      }

      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);

      if (!sourceNode || !targetNode) {
        console.log('Rejected: node not found');
        return false;
      }

      console.log('Connecting:', sourceNode.data.serviceId, '→', targetNode.data.serviceId);

      // Check if connection already exists (in either direction)
      const existingConnection = edges.find(
        (e) =>
          (e.source === connection.source && e.target === connection.target) ||
          (e.source === connection.target && e.target === connection.source)
      );
      if (existingConnection) {
        console.log('Rejected: connection already exists');
        return false;
      }

      // Check if services can connect (either direction is valid)
      const canConnectForward = canConnect(sourceNode.data.serviceId, targetNode.data.serviceId);
      const canConnectBackward = canConnect(targetNode.data.serviceId, sourceNode.data.serviceId);

      console.log('canConnect:', { forward: canConnectForward, backward: canConnectBackward });

      return canConnectForward || canConnectBackward;
    },
    [nodes, edges]
  );

  const handleConnect = useCallback(
    (connection: { source: string | null; target: string | null; sourceHandle: string | null; targetHandle: string | null }) => {
      if (onConnectValidate(connection)) {
        onConnect(connection);
      }
    },
    [onConnect, onConnectValidate]
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-gray-50 dark:bg-gray-950 relative">
      {/* Mobile Service Palette Toggle */}
      {isMobile && (
        <Button
          variant="default"
          size="sm"
          className="absolute top-14 left-2 z-50 gap-2 shadow-lg"
          onClick={() => setShowPalette(!showPalette)}
        >
          <Layers className="w-4 h-4" />
          <span className="text-xs">Services</span>
        </Button>
      )}

      {/* Service Palette - Desktop: always visible, Mobile: slide-over */}
      <div
        className={`
          ${isMobile
            ? `fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out ${showPalette ? 'translate-x-0' : '-translate-x-full'}`
            : 'relative'
          }
        `}
      >
        {isMobile && showPalette && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 z-10 h-8 w-8"
            onClick={() => setShowPalette(false)}
          >
            <X className="w-4 h-4" />
          </Button>
        )}
        <ServicePalette onDragStart={(e, service) => {
          onDragStart(e, service);
          if (isMobile) setShowPalette(false);
        }} />
      </div>

      {/* Mobile Overlay */}
      {isMobile && showPalette && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setShowPalette(false)}
        />
      )}

      {/* Main Canvas Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <DesignerToolbar isMobile={isMobile} />

        {/* Canvas */}
        <div ref={reactFlowWrapper} className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onPaneClick={() => selectNode(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            snapToGrid
            snapGrid={[15, 15]}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{
              stroke: '#22c55e',
              strokeWidth: 2,
              strokeDasharray: '5 5',
            }}
            defaultEdgeOptions={{
              type: 'deletable',
              animated: false,
            }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
            isValidConnection={(connection) => {
              // Allow all connections - validation happens in handleConnect
              if (!connection.source || !connection.target) return false;
              if (connection.source === connection.target) return false;
              return true;
            }}
          >
            <Background gap={15} size={1} color="#e5e7eb" />
            <Controls
              className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 !shadow-lg"
              position={isMobile ? 'bottom-right' : 'bottom-left'}
            />
            {!isMobile && (
              <MiniMap
                nodeColor={(node) => node.data?.color || '#6366f1'}
                maskColor="rgba(0,0,0,0.1)"
                className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700"
              />
            )}
          </ReactFlow>

          {/* Connection Legend */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 rounded-lg shadow-lg px-4 py-2 flex items-center gap-4 text-xs border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500 border-2 border-white shadow" />
              <span className="text-gray-600 dark:text-gray-300">Output</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400" />
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow" />
              <span className="text-gray-600 dark:text-gray-300">Input</span>
            </div>
          </div>

          {/* Empty State */}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-4">
              <div className="text-center">
                <div className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-8 h-8 md:w-10 md:h-10 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                </div>
                <h3 className="text-base md:text-lg font-medium text-gray-900 dark:text-white mb-1">
                  Start designing your architecture
                </h3>
                <p className="text-xs md:text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto mb-3">
                  {isMobile
                    ? 'Tap "Services" to add AWS services to your canvas'
                    : 'Drag AWS services from the left panel onto the canvas to begin building your infrastructure'
                  }
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                  <span>Connect services:</span>
                  <div className="flex items-center gap-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                    <span>OUT</span>
                  </div>
                  <ArrowRight className="w-3 h-3" />
                  <div className="flex items-center gap-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                    <span>IN</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Code Panel */}
        <CodePanel isMobile={isMobile} />
      </div>

      {/* Properties Panel */}
      <PropertiesPanel isMobile={isMobile} />
    </div>
  );
}

export function DesignerCanvas() {
  return (
    <ReactFlowProvider>
      <DesignerCanvasInner />
    </ReactFlowProvider>
  );
}
