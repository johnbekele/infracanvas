// Turning a GitHub access token into a logged-in session.
//
// Both auth providers converge here. OAuth and the local token source differ
// only in how they obtain a token; everything after that -- identifying the
// account, upserting the user, encrypting the token, issuing the cookie -- is
// identical, and duplicating it would be the kind of divergence that leaves one
// path with a security fix the other never got.

import { type Response } from 'express';
import { createSessionToken, SESSION_DURATION_MS, SESSION_MAX_AGE_MS } from '../jwt.js';
import { findOrCreateUser } from '../db/users.js';
import { saveGitHubToken } from '../db/tokens.js';
import { createSession, type AuthMethodId } from '../db/sessions.js';
import { CSRF_COOKIE, csrfCookieOptions, setSessionCookie } from './cookie.js';
import { mintCsrfToken } from './csrf.js';

const GITHUB_USER_URL = 'https://api.github.com/user';

/** The subset of GitHub's user payload this application stores. */
interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
  email: string | null;
}

export interface GitHubCredentials {
  accessToken: string;
  tokenType: string;
  scope: string;
}

export type SessionResult = { ok: true; username: string } | { ok: false; reason: string };

export interface SessionContext {
  /** Which sign-in path produced these credentials. */
  authMethod: AuthMethodId;
  /** Where the token came from under the local method, for the status endpoint. */
  tokenOrigin?: string | null;
  userAgent?: string | null;
}

/**
 * Identify the GitHub account behind `credentials`, persist it, and set the
 * session cookie on `res`.
 *
 * The failure `reason` is written for a human to act on and is safe to show:
 * it never contains the token, and never repeats a message from GitHub that
 * might.
 */
export async function establishSession(
  res: Response,
  credentials: GitHubCredentials,
  context: SessionContext
): Promise<SessionResult> {
  const userResponse = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!userResponse.ok) {
    // 401 here means the token is bad, which for the local provider usually
    // means an expired `gh` login. Saying so saves a round of guessing.
    const reason =
      userResponse.status === 401
        ? 'GitHub rejected the token. If it came from the gh CLI, run `gh auth login` again.'
        : `GitHub returned ${userResponse.status} when identifying the account.`;
    return { ok: false, reason };
  }

  const githubUser = (await userResponse.json()) as GitHubUser;

  const user = await findOrCreateUser({
    githubId: githubUser.id,
    githubUsername: githubUser.login,
    githubAvatar: githubUser.avatar_url,
    email: githubUser.email || undefined,
    name: githubUser.name || undefined,
  });

  await saveGitHubToken({
    userId: user.id,
    accessToken: credentials.accessToken,
    tokenType: credentials.tokenType,
    scope: credentials.scope,
  });

  // Recorded before the token is signed, because the token names the row: a
  // session that cannot be found is a session that cannot be revoked.
  const session = await createSession({
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
    authMethod: context.authMethod,
    tokenOrigin: context.tokenOrigin ?? null,
    userAgent: context.userAgent ?? null,
  });

  const sessionToken = await createSessionToken({
    userId: user.id,
    githubId: user.githubId,
    githubUsername: user.githubUsername,
    sessionId: session.id,
  });

  setSessionCookie(res, sessionToken, SESSION_DURATION_MS);
  // Bound to the session row id so a rotated cookie always carries a matching
  // CSRF companion. setSessionCookie also writes this on refresh.
  res.cookie(CSRF_COOKIE, mintCsrfToken(session.id), {
    ...csrfCookieOptions(),
    maxAge: SESSION_DURATION_MS,
  });

  return { ok: true, username: user.githubUsername };
}
