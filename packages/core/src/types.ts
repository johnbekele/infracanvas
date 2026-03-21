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

// Service node data used in the designer
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
