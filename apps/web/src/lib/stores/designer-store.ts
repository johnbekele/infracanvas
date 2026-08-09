import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  type Node,
  type Edge,
  type Connection,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from 'reactflow';

export interface ServiceNodeData {
  serviceId: string;
  serviceName: string;
  shortName: string;
  color: string;
  category: string;
  properties: Record<string, string | number | boolean>;
  nodeType?: 'service' | 'vpc-environment' | 'public-subnet' | 'private-subnet';
  parentId?: string;
}

export interface SubnetHierarchy {
  subnetNode: Node<ServiceNodeData>;
  services: Node<ServiceNodeData>[];
}

export interface VpcHierarchy {
  vpcNode: Node<ServiceNodeData>;
  publicSubnets: SubnetHierarchy[];
  privateSubnets: SubnetHierarchy[];
}

export type PulumiLanguage = 'typescript' | 'python';

export interface DesignerState {
  // Canvas state
  nodes: Node<ServiceNodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;

  // UI state
  isPanelOpen: boolean;
  activeTab: 'properties' | 'terraform' | 'pulumi';
  pulumiLanguage: PulumiLanguage;

  // Design metadata
  designName: string;
  designId: string | null;
  lastSaved: Date | null;
  isDirty: boolean;

  // Actions
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  addNode: (node: Node<ServiceNodeData>) => void;
  removeNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<ServiceNodeData>) => void;
  updateNodeProperty: (
    nodeId: string,
    propertyName: string,
    value: string | number | boolean
  ) => void;

  selectNode: (nodeId: string | null) => void;

  setDesignName: (name: string) => void;
  setPanelOpen: (open: boolean) => void;
  setActiveTab: (tab: 'properties' | 'terraform' | 'pulumi') => void;
  setPulumiLanguage: (language: PulumiLanguage) => void;

  clearCanvas: () => void;
  loadDesign: (nodes: Node<ServiceNodeData>[], edges: Edge[], name: string, id?: string) => void;
  markSaved: (id: string) => void;

  // Nesting actions for VPC environments
  setNodeParent: (nodeId: string, parentId: string | null) => void;
  getChildNodes: (parentId: string) => Node<ServiceNodeData>[];
  getVpcHierarchy: () => VpcHierarchy[];
  removeNodeWithChildren: (nodeId: string) => void;
}

const STORE_VERSION = 1;

const initialState = {
  nodes: [] as Node<ServiceNodeData>[],
  edges: [] as Edge[],
  selectedNodeId: null,
  isPanelOpen: true,
  activeTab: 'properties' as const,
  pulumiLanguage: 'typescript' as PulumiLanguage,
  designName: 'Untitled Design',
  designId: null,
  lastSaved: null,
  isDirty: false,
  storeVersion: STORE_VERSION,
};

export const useDesignerStore = create<DesignerState>()(
  persist(
    (set, get) => ({
      ...initialState,

      onNodesChange: (changes) => {
        set({
          nodes: applyNodeChanges(changes, get().nodes),
          isDirty: true,
        });
      },

      onEdgesChange: (changes) => {
        set({
          edges: applyEdgeChanges(changes, get().edges),
          isDirty: true,
        });
      },

      onConnect: (connection) => {
        set({
          edges: addEdge(
            {
              ...connection,
              type: 'deletable',
              animated: true,
              style: { stroke: '#6366f1', strokeWidth: 2 },
            },
            get().edges
          ),
          isDirty: true,
        });
      },

      addNode: (node) => {
        set({
          nodes: [...get().nodes, node],
          isDirty: true,
        });
      },

      removeNode: (nodeId) => {
        set({
          nodes: get().nodes.filter((n) => n.id !== nodeId),
          edges: get().edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeId: get().selectedNodeId === nodeId ? null : get().selectedNodeId,
          isDirty: true,
        });
      },

      updateNodeData: (nodeId, data) => {
        set({
          nodes: get().nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
          ),
          isDirty: true,
        });
      },

      updateNodeProperty: (nodeId, propertyName, value) => {
        set({
          nodes: get().nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    properties: {
                      ...node.data.properties,
                      [propertyName]: value,
                    },
                  },
                }
              : node
          ),
          isDirty: true,
        });
      },

      selectNode: (nodeId) => {
        set({
          selectedNodeId: nodeId,
          isPanelOpen: nodeId !== null,
        });
      },

      setDesignName: (name) => {
        set({ designName: name, isDirty: true });
      },

      setPanelOpen: (open) => {
        set({ isPanelOpen: open });
      },

      setActiveTab: (tab) => {
        set({ activeTab: tab });
      },

      setPulumiLanguage: (language) => {
        set({ pulumiLanguage: language });
      },

      clearCanvas: () => {
        set({
          ...initialState,
          designName: 'Untitled Design',
        });
      },

      loadDesign: (nodes, edges, name, id) => {
        const migratedEdges = edges.map((edge) => ({
          ...edge,
          type: 'deletable',
        }));
        set({
          nodes,
          edges: migratedEdges,
          designName: name,
          designId: id || null,
          isDirty: false,
          selectedNodeId: null,
        });
      },

      markSaved: (id) => {
        set({
          designId: id,
          lastSaved: new Date(),
          isDirty: false,
        });
      },

      setNodeParent: (nodeId, parentId) => {
        set({
          nodes: get().nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  parentNode: parentId || undefined,
                  extent: parentId ? 'parent' : undefined,
                  data: {
                    ...node.data,
                    parentId: parentId || undefined,
                  },
                }
              : node
          ),
          isDirty: true,
        });
      },

      getChildNodes: (parentId) => {
        return get().nodes.filter((n) => n.parentNode === parentId);
      },

      getVpcHierarchy: () => {
        const nodes = get().nodes;
        const vpcs = nodes.filter((n) => n.data.serviceId === 'vpc-environment');

        return vpcs.map((vpc) => {
          const subnets = nodes.filter((n) => n.parentNode === vpc.id);
          const publicSubnets = subnets.filter((s) => s.data.serviceId === 'public-subnet');
          const privateSubnets = subnets.filter((s) => s.data.serviceId === 'private-subnet');

          return {
            vpcNode: vpc,
            publicSubnets: publicSubnets.map((subnet) => ({
              subnetNode: subnet,
              services: nodes.filter((n) => n.parentNode === subnet.id),
            })),
            privateSubnets: privateSubnets.map((subnet) => ({
              subnetNode: subnet,
              services: nodes.filter((n) => n.parentNode === subnet.id),
            })),
          };
        });
      },

      removeNodeWithChildren: (nodeId) => {
        const nodes = get().nodes;
        const edges = get().edges;

        const findAllChildren = (parentId: string): string[] => {
          const children = nodes.filter((n) => n.parentNode === parentId);
          const childIds = children.map((c) => c.id);
          const grandchildIds = children.flatMap((c) => findAllChildren(c.id));
          return [...childIds, ...grandchildIds];
        };

        const allChildIds = findAllChildren(nodeId);
        const idsToRemove = new Set([nodeId, ...allChildIds]);

        set({
          nodes: nodes.filter((n) => !idsToRemove.has(n.id)),
          edges: edges.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)),
          selectedNodeId: idsToRemove.has(get().selectedNodeId || '') ? null : get().selectedNodeId,
          isDirty: true,
        });
      },
    }),
    {
      name: 'infracanvas-designer-v1',
      partialize: (state) => ({
        nodes: state.nodes,
        edges: state.edges,
        designName: state.designName,
        designId: state.designId,
        pulumiLanguage: state.pulumiLanguage,
        storeVersion: STORE_VERSION,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        const storedVersion = (state as typeof state & { storeVersion?: number }).storeVersion;
        if (!storedVersion || storedVersion < STORE_VERSION) {
          state.nodes = [];
          state.edges = [];
          state.designName = 'Untitled Design';
          state.designId = null;
          (state as typeof state & { storeVersion: number }).storeVersion = STORE_VERSION;
          return;
        }

        if (state.nodes) {
          state.nodes = state.nodes.filter((node) => {
            if (!node.data || !node.data.serviceId) {
              return false;
            }
            return true;
          });

          const nodeMap = new Map(state.nodes.map((n) => [n.id, n]));

          const hasCycle = (nodeId: string, visited: Set<string> = new Set()): boolean => {
            if (visited.has(nodeId)) return true;
            visited.add(nodeId);
            const node = nodeMap.get(nodeId);
            if (node?.parentNode) {
              return hasCycle(node.parentNode, visited);
            }
            return false;
          };

          state.nodes = state.nodes.map((node) => {
            if (node.parentNode) {
              if (!nodeMap.has(node.parentNode)) {
                return { ...node, parentNode: undefined, extent: undefined };
              }
              if (node.parentNode === node.id) {
                return { ...node, parentNode: undefined, extent: undefined };
              }
              if (hasCycle(node.id)) {
                return { ...node, parentNode: undefined, extent: undefined };
              }
            }
            return node;
          });

          state.nodes = state.nodes.map((node) => {
            if (node.type === 'vpcEnvironment') {
              return {
                ...node,
                width: (node.style?.width as number) || (node.width as number) || 500,
                height: (node.style?.height as number) || (node.height as number) || 400,
                zIndex: -2,
                style: {
                  ...node.style,
                  width: (node.style?.width as number) || (node.width as number) || 500,
                  height: (node.style?.height as number) || (node.height as number) || 400,
                },
              };
            }
            if (node.type === 'subnet') {
              return {
                ...node,
                width: (node.style?.width as number) || (node.width as number) || 220,
                height: (node.style?.height as number) || (node.height as number) || 180,
                zIndex: -1,
                style: {
                  ...node.style,
                  width: (node.style?.width as number) || (node.width as number) || 220,
                  height: (node.style?.height as number) || (node.height as number) || 180,
                },
              };
            }
            return node;
          });
        }

        if (state.edges) {
          state.edges = state.edges.map((edge) => ({
            ...edge,
            type: 'deletable',
          }));
        }
      },
    }
  )
);
