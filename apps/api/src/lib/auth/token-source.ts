// Where a GitHub token comes from when there is no OAuth application.
//
// Two sources, in order. `GITHUB_TOKEN` is explicit and works anywhere,
// including a container that has no `gh` binary. The `gh` CLI is the
// zero-setup path: a developer who has run `gh auth login` already has a token,
// and asking them to mint a second one by hand is friction with no security
// benefit.

import { execFile } from 'node:child_process';

export type TokenOrigin = 'env' | 'gh-cli';

export interface ResolvedToken {
  token: string;
  origin: TokenOrigin;
}

/** Long enough for a keychain unlock prompt, short enough not to hang a request. */
const GH_TIMEOUT_MS = 5_000;

/**
 * `gh` reads its token from the OS keyring, so this must not run under a
 * restricted environment that strips HOME. Rejects rather than throws, and
 * never surfaces stderr to the caller: a failure from `gh` can echo back the
 * token in some configurations.
 */
function readTokenFromGhCli(): Promise<string | null> {
  return new Promise((resolve) => {
    // execFile, not exec: no shell is involved, so nothing here can be
    // interpreted as a command even if the environment is hostile.
    execFile('gh', ['auth', 'token'], { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const token = stdout.trim();
      resolve(token.length > 0 ? token : null);
    });
  });
}

/**
 * Resolve a GitHub token from the environment, then from the `gh` CLI.
 *
 * Returns null when neither yields one, leaving the caller to produce a message
 * with the context to fix it.
 */
export async function resolveGitHubToken(): Promise<ResolvedToken | null> {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, origin: 'env' };
  }

  const fromCli = await readTokenFromGhCli();
  if (fromCli) {
    return { token: fromCli, origin: 'gh-cli' };
  }

  return null;
}

/**
 * What to tell an operator who has no token available.
 *
 * Kept next to the resolution order so the two cannot drift: a message listing
 * the wrong sources is worse than no message.
 */
export const NO_TOKEN_GUIDANCE =
  'No GitHub token available. Either set GITHUB_TOKEN, or run `gh auth login` so the ' +
  'gh CLI can provide one. To use the hosted OAuth flow instead, set AUTH_PROVIDER=oauth.';
