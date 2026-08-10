import type { ResourceContract } from '../contract';
import { cost } from './cost';
import { emitPulumi } from './emit';
import { latency } from './latency';
import { reliability } from './reliability';
import { rules } from './rules';

export const rdsInstanceContract: ResourceContract<'rds_instance'> = {
  kind: 'rds_instance',
  paramsDef: 'rdsInstanceParams',
  cost,
  latency,
  reliability,
  rules,
  emitPulumi,
};

export { cost, emitPulumi, latency, reliability, rules };
