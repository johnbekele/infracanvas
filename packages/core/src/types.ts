// InfraCanvas Architecture Designer Types

export interface ArchitectureDesign {
  id: string;
  name: string;
  nodes: DesignNode[];
  connections: DesignConnection[];
  viewport: Viewport;
  createdAt: Date;
  updatedAt: Date;
}

export interface DesignNode {
  id: string;
  serviceId: string;
  position: { x: number; y: number };
  /**
   * Superseded by `IrNodeData.params` in `./ir/canvas`, which is typed per
   * resource kind rather than being a bag of scalars. Kept because `apps/web`
   * still reads it; the designer moves across in the web epic.
   */
  properties: Record<string, string | number | boolean>;
}

export interface DesignConnection {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GeneratedCode {
  terraform: string;
  pulumi: string;
}

export type CodeLanguage = 'terraform' | 'pulumi';

/** Container services that hold other nodes on the canvas. */
export type ContainerNodeType =
  | 'vpc-environment'
  | 'public-subnet'
  | 'private-subnet'
  | 'availability-zone'
  | 'ecs-cluster'
  | 'eks-cluster';

// Service node data used in the designer
export interface ServiceNodeData {
  serviceId: string;
  serviceName: string;
  shortName: string;
  color: string;
  category: string;
  /**
   * Superseded by `IrNodeData.params` in `./ir/canvas`. A cost model cannot
   * read `Record<string, string | number | boolean>` and know that `memory` is
   * mebibytes, which is the whole reason the IR exists. Kept because
   * `apps/web` still reads it.
   */
  properties: Record<string, string | number | boolean>;
  nodeType?: 'service' | ContainerNodeType;
  parentId?: string;
  /** Repository paths a proposed node was inferred from. Absent when hand-placed. */
  evidence?: string[];
  confidence?: 'high' | 'medium' | 'low';
  /** The repository component this node deploys, for proposed nodes. */
  componentPath?: string;
}

// Hierarchy types for code generation
export interface SubnetHierarchy {
  subnetNode: {
    id: string;
    data: ServiceNodeData;
    position: { x: number; y: number };
    parentNode?: string;
  };
  services: Array<{
    id: string;
    data: ServiceNodeData;
    position: { x: number; y: number };
    parentNode?: string;
  }>;
}

export interface VpcHierarchy {
  vpcNode: {
    id: string;
    data: ServiceNodeData;
    position: { x: number; y: number };
  };
  publicSubnets: SubnetHierarchy[];
  privateSubnets: SubnetHierarchy[];
}

export type PulumiLanguage = 'typescript' | 'python';
