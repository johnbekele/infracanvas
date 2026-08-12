import { rdsInstanceContract } from './rds-instance';
import { registerResource } from './registry';

/**
 * Registration is a call rather than an import side effect. A module that
 * registers itself when imported makes the contents of the registry depend on
 * which files a bundler happened to keep, and a missing resource would show up
 * as a silently cheaper architecture.
 */
export function registerBuiltInResources(): void {
  registerResource(rdsInstanceContract);
}

export * from './contract';
export { evaluateArchitecture, type ArchitectureFindings } from './evaluate';
export * from './registry';
export { rdsInstanceContract } from './rds-instance';
