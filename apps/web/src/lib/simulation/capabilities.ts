import {
  AWS_SLAS,
  awsServices,
  listResourceContracts,
  registerBuiltInResources,
} from '@infracanvas/core';

/**
 * What the platform can actually do, counted from the code rather than written
 * down beside it.
 *
 * The landing page needs numbers, and the tempting ones -- teams onboarded,
 * dollars saved, architectures deployed -- are numbers we do not have. Quoting
 * them on the front of a tool whose entire argument is "we show our working"
 * would undermine the argument on the way in. These are derived at module load
 * from the catalogue, the contract registry and the SLA table, so they cannot
 * drift from what the product does and cannot be inflated.
 */

export interface Capabilities {
  services: number;
  contracts: number;
  rules: number;
  slas: number;
}

let cached: Capabilities | null = null;

export function capabilities(): Capabilities {
  if (cached !== null) return cached;

  // Contracts register themselves on first use, and the landing page is
  // usually the first thing loaded, so nothing else has done it yet.
  registerBuiltInResources();
  const contracts = listResourceContracts();

  cached = {
    services: awsServices.length,
    contracts: contracts.length,
    rules: contracts.reduce((sum, contract) => sum + contract.rules.length, 0),
    slas: AWS_SLAS.length,
  };
  return cached;
}
