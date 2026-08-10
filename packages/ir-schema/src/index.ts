export type {
  ArchitectureIr,
  Edge as IrEdge,
  EdgeKind as IrEdgeKind,
  Layout as IrLayout,
  NodeBase as IrNodeBase,
  PendingContractKind,
  PendingContractNode,
  PendingParams,
  Presentation as IrPresentation,
  ResourceId,
  ResourceKind,
  SubnetNode,
  SubnetParams,
  SubnetTier,
  Viewport as IrViewport,
  VpcNode,
  VpcParams,
} from './generated/types.js';
export type { IrNode } from './nodes.js';
export {
  assertValidIr,
  IrValidationError,
  pendingContractKinds,
  resourceKinds,
  validateIr,
  type IrProblem,
  type IrValidationResult,
} from './validate.js';
export { IR_SCHEMA_ID, IR_VERSION } from './generated/ir-version.js';
