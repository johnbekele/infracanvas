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

/** A GitHub login: alphanumeric and hyphens, which is the whole character set. */
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

export class InvalidAccountError extends Error {
  constructor(account: string) {
    super(
      `GITHUB_ACCOUNT is not a GitHub username: ${JSON.stringify(account)}. ` +
        'Use the login exactly as it appears in `gh auth status`.'
    );
    this.name = 'InvalidAccountError';
  }
}

/**
 * `gh` reads its token from the OS keyring, so this must not run under a
 * restricted environment that strips HOME. Rejects rather than throws, and
 * never surfaces stderr to the caller: a failure from `gh` can echo back the
 * token in some configurations.
 *
 * `account` names which login to ask for on a machine signed in to more than
 * one. Without it `gh` answers with whichever account its config calls active,
 * and on a work laptop that is reliably the wrong one - the failure is silent,
 * because the token is valid and the session it creates is real. Someone then
 * connects a repository as an identity they did not choose.
 */
function readTokenFromGhCli(account?: string): Promise<string | null> {
  // Validated rather than escaped. execFile passes arguments without a shell, so
  // this cannot become a command; the check is here because a typo should be an
  // error naming the variable, not a token for nobody.
  if (account !== undefined && !LOGIN_PATTERN.test(account)) {
    throw new InvalidAccountError(account);
  }

  const args = account === undefined ? ['auth', 'token'] : ['auth', 'token', '--user', account];

  return new Promise((resolve) => {
    // execFile, not exec: no shell is involved, so nothing here can be
    // interpreted as a command even if the environment is hostile.
    execFile('gh', args, { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
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

  const account = process.env.GITHUB_ACCOUNT?.trim();
  const fromCli = await readTokenFromGhCli(account === '' ? undefined : account);
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
  'gh CLI can provide one. On a machine signed in to more than one account, set ' +
  'GITHUB_ACCOUNT to the login you want. To use the hosted OAuth flow instead, set ' +
  'AUTH_PROVIDER=oauth.';
