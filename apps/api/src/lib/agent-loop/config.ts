/**
 * Where the loop keeps its state, and whether the dashboard is allowed to touch
 * it. Both are resolved here so the routes, the source, and the controls agree.
 *
 * The feature is powerful — it reads local files and can spawn or signal a
 * process — so it is off unless explicitly enabled, and on by default only
 * outside production, where the loop and this API share one machine.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The `.agent-loop` directory. Honours `AGENT_LOOP_DIR`, else walks up from the
 * working directory to the workspace root (the folder with pnpm-workspace.yaml)
 * and appends `.agent-loop`, so it resolves whether the API is started from the
 * repository root or from `apps/api`.
 */
export function resolveStateDir(): string {
  const override = process.env.AGENT_LOOP_DIR;
  if (override && override.trim()) return resolve(override.trim());

  let dir = process.cwd();
  for (let hops = 0; hops < 8; hops += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.agent-loop');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), '.agent-loop');
}

/** The workspace root the loop runs in: the parent of the state directory. */
export function resolveRepoRoot(stateDir: string): string {
  return dirname(stateDir);
}

/**
 * Whether the dashboard and its controls are exposed. `AGENT_LOOP_ENABLED=1`
 * forces it on and `=0` forces it off; unset, it is on outside production only.
 */
export function isEnabled(): boolean {
  const flag = process.env.AGENT_LOOP_ENABLED;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.env.NODE_ENV !== 'production';
}
