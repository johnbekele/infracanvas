export type { ArchitectureIr, IrEdge, IrLayout, IrNode, IrPresentation } from './document.js';
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
