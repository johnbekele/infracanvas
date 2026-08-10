/**
 * The document shape, hand-written only until
 * `docs/issues/epic-2-ir/020-ir-type-generation.md` replaces this module with
 * types generated from the schema.
 *
 * It is deliberately structural rather than a second, precise description of
 * every node kind. Hand-writing the discriminated union here would recreate
 * exactly the drift this package exists to prevent: the schema would say one
 * thing and this file another, and only one of them is checked at runtime.
 */

export interface IrLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface IrNode {
  id: string;
  kind: string;
  name: string;
  parent?: string | null;
  layout?: IrLayout;
  params: Record<string, unknown>;
}

export interface IrEdge {
  id: string;
  kind: 'connects' | 'depends_on' | 'routes_to';
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface IrPresentation {
  viewport?: { x: number; y: number; zoom: number };
}

export interface ArchitectureIr {
  irVersion: string;
  name: string;
  provider: 'aws';
  region: string;
  nodes: IrNode[];
  edges: IrEdge[];
  presentation?: IrPresentation;
}
