import { useCallback, useRef, useState, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  ConnectionLineType,
  ConnectionMode,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Layers, X, ArrowRight } from 'lucide-react';

import { useDesignerStore, type ServiceNodeData } from '@/lib/stores/designer-store';
import { type AWSService, canConnect } from '@infracanvas/core';
import {
  CONTAINER_DEFAULT_SIZE,
  absolutePosition,
  canNest,
  containerAt,
  containerZIndex,
  grownSize,
  positionWithin,
  sizeOf,
} from '@/lib/designer/containment';
import { ServiceNode } from './ServiceNode';
import { VpcEnvironmentNode } from './VpcEnvironmentNode';
import { SubnetNode } from './SubnetNode';
import { ClusterNode } from './ClusterNode';
import { ServicePalette } from './ServicePalette';
import { PropertiesPanel } from './PropertiesPanel';
import { EstimatePanel } from './estimate/EstimatePanel';
import { CodePanel } from './CodePanel';
import { DesignerToolbar } from './DesignerToolbar';
import { DeletableEdge } from './DeletableEdge';
import { Button } from '@/components/ui/button';

const nodeTypes = {
  serviceNode: ServiceNode,
  vpcEnvironment: VpcEnvironmentNode,
  subnet: SubnetNode,
  cluster: ClusterNode,
};

/** Which React Flow component draws a service. */
function nodeTypeFor(serviceId: string): string {
  if (serviceId === 'vpc-environment') return 'vpcEnvironment';
  if (serviceId === 'public-subnet' || serviceId === 'private-subnet') return 'subnet';
  if (serviceId in CONTAINER_DEFAULT_SIZE) return 'cluster';
  return 'serviceNode';
}

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
    reparentNode,
    resizeNode,
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

  const onDragStart = useCallback((event: React.DragEvent, service: AWSService) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify(service));
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * Grow a container so a child that was just placed near its edge still fits.
   *
   * Without this a service dropped at the bottom of a VPC is clipped by
   * `extent: 'parent'`, and the user has to resize the box by hand before the
   * thing they dropped is visible.
   */
  const growAncestors = useCallback(
    (parentId: string | undefined, current: Node<ServiceNodeData>[]) => {
      let ancestorId = parentId;

      while (ancestorId) {
        const ancestor = current.find((node) => node.id === ancestorId);
        if (!ancestor) break;

        const children = current
          .filter((node) => node.parentNode === ancestor.id)
          .map((node) => ({ position: node.position, size: sizeOf(node) }));

        const size = sizeOf(ancestor);
        const grown = grownSize(size, children);
        if (grown.width !== size.width || grown.height !== size.height) {
          resizeNode(ancestor.id, grown);
        }

        ancestorId = ancestor.parentNode;
      }
    },
    [resizeNode]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const data = event.dataTransfer.getData('application/reactflow');
      if (!data) return;

      const service: AWSService = JSON.parse(data);

      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const container = containerAt(flowPosition, nodes);

      // A rejected drop is silent on purpose: the palette item simply does not
      // land, the same as dragging a file onto something that cannot accept it.
      if (!canNest(service.id, container?.data.serviceId ?? null)) return;

      const parentNode = container?.id;
      const position = positionWithin(flowPosition, container, nodes);

      const properties: Record<string, string | number | boolean> = {};
      service.properties.forEach((prop) => {
        properties[prop.name] = prop.default;
      });

      const nodeType = nodeTypeFor(service.id);
      const newNode: Parameters<typeof addNode>[0] = {
        id: getNodeId(),
        type: nodeType,
        position,
        parentNode,
        extent: parentNode ? 'parent' : undefined,
        data: {
          serviceId: service.id,
          serviceName: service.name,
          shortName: service.shortName,
          color: service.color,
          category: service.category,
          properties,
          nodeType: service.isContainer ? (service.id as ServiceNodeData['nodeType']) : 'service',
          parentId: parentNode,
        },
      };

      const defaultSize = CONTAINER_DEFAULT_SIZE[service.id];
      if (defaultSize) {
        Object.assign(newNode, {
          style: { width: defaultSize.width, height: defaultSize.height },
          width: defaultSize.width,
          height: defaultSize.height,
          zIndex: containerZIndex(service.id),
        });
      }

      addNode(newNode);
      growAncestors(parentNode, [
        ...nodes,
        { ...newNode, data: newNode.data } as Node<ServiceNodeData>,
      ]);
    },
    [screenToFlowPosition, addNode, nodes, growAncestors]
  );

  /**
   * Reparent a node when it is dropped somewhere else.
   *
   * Nesting is not decoration: a service inside a private subnet generates
   * different Terraform than the same service on open canvas. Until now the
   * only way to set a parent was to drop from the palette, so an existing node
   * could never be moved into a VPC.
   */
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node<ServiceNodeData>) => {
      const absolute = absolutePosition(node, nodes);
      const container = containerAt(absolute, nodes, node.id);
      const nextParent = container?.id ?? null;
      const currentParent = node.parentNode ?? null;

      if (nextParent === currentParent) {
        growAncestors(node.parentNode, nodes);
        return;
      }

      if (!canNest(node.data.serviceId, container?.data.serviceId ?? null)) return;

      reparentNode(node.id, nextParent, positionWithin(absolute, container, nodes));
      growAncestors(nextParent ?? undefined, nodes);
    },
    [nodes, reparentNode, growAncestors]
  );

  const onConnectValidate = useCallback(
    (connection: {
      source: string | null;
      target: string | null;
      sourceHandle: string | null;
      targetHandle: string | null;
    }) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;

      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return false;

      const alreadyConnected = edges.some(
        (e) =>
          (e.source === connection.source && e.target === connection.target) ||
          (e.source === connection.target && e.target === connection.source)
      );
      if (alreadyConnected) return false;

      // Either direction counts: the user drew a relationship, and which end
      // they started from says nothing about which way traffic flows.
      return (
        canConnect(sourceNode.data.serviceId, targetNode.data.serviceId) ||
        canConnect(targetNode.data.serviceId, sourceNode.data.serviceId)
      );
    },
    [nodes, edges]
  );

  const handleConnect = useCallback(
    (connection: {
      source: string | null;
      target: string | null;
      sourceHandle: string | null;
      targetHandle: string | null;
    }) => {
      if (onConnectValidate(connection)) {
        onConnect(connection);
      }
    },
    [onConnect, onConnectValidate]
  );

  return (
    <div className="relative flex h-[calc(100vh-4rem)] bg-gray-50 dark:bg-gray-950">
      {/* Mobile Service Palette Toggle */}
      {isMobile && (
        <Button
          variant="default"
          size="sm"
          className="absolute left-2 top-14 z-50 gap-2 shadow-lg"
          onClick={() => setShowPalette(!showPalette)}
        >
          <Layers className="h-4 w-4" />
          <span className="text-xs">Services</span>
        </Button>
      )}

      {/* Service Palette - Desktop: always visible, Mobile: slide-over */}
      <div
        className={` ${
          isMobile
            ? `fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out ${showPalette ? 'translate-x-0' : '-translate-x-full'}`
            : 'relative'
        } `}
      >
        {isMobile && showPalette && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-10 h-8 w-8"
            onClick={() => setShowPalette(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        <ServicePalette
          onDragStart={(e, service) => {
            onDragStart(e, service);
            if (isMobile) setShowPalette(false);
          }}
        />
      </div>

      {/* Mobile Overlay */}
      {isMobile && showPalette && (
        <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setShowPalette(false)} />
      )}

      {/* Main Canvas Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <DesignerToolbar isMobile={isMobile} />

        {/* Canvas */}
        <div ref={reactFlowWrapper} className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeDragStop={onNodeDragStop}
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
              className="!border-gray-200 !bg-white !shadow-lg dark:!border-gray-700 dark:!bg-gray-800"
              position={isMobile ? 'bottom-right' : 'bottom-left'}
            />
            {!isMobile && (
              <MiniMap
                nodeColor={(node) => node.data?.color || '#6366f1'}
                maskColor="rgba(0,0,0,0.1)"
                className="!border-gray-200 !bg-white dark:!border-gray-700 dark:!bg-gray-800"
              />
            )}
          </ReactFlow>

          {/* Connection Legend */}
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full border-2 border-white bg-green-500 shadow" />
              <span className="text-gray-600 dark:text-gray-300">Output</span>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-400" />
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full border-2 border-white bg-blue-500 shadow" />
              <span className="text-gray-600 dark:text-gray-300">Input</span>
            </div>
          </div>

          {/* Empty State */}
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 md:h-20 md:w-20 dark:bg-gray-800">
                  <svg
                    className="h-8 w-8 text-gray-400 md:h-10 md:w-10"
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
                <h3 className="mb-1 text-base font-medium text-gray-900 md:text-lg dark:text-white">
                  Start designing your architecture
                </h3>
                <p className="mx-auto mb-3 max-w-xs text-xs text-gray-500 md:text-sm dark:text-gray-400">
                  {isMobile
                    ? 'Tap "Services" to add AWS services to your canvas'
                    : 'Drag AWS services from the left panel onto the canvas to begin building your infrastructure'}
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                  <span>Connect services:</span>
                  <div className="flex items-center gap-1">
                    <div className="h-2.5 w-2.5 rounded-full bg-green-500" />
                    <span>OUT</span>
                  </div>
                  <ArrowRight className="h-3 w-3" />
                  <div className="flex items-center gap-1">
                    <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
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

      {/* Estimate Panel */}
      <EstimatePanel isMobile={isMobile} />
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
