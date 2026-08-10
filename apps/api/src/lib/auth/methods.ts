// Which sign-in methods a given caller can actually use.
//
// `AUTH_PROVIDER` was read once at boot and memoised, which made a deployment
// permanently one thing. An operator who registered an OAuth application and
// set GITHUB_CLIENT_ID while the variable still said `token` got no error and
// no OAuth flow: the credentials were simply never read. The two are not
// alternatives for a deployment, they are alternatives for a sign-in, and the
// person signing in is the one who knows which they want.
import { type Request } from 'express';
import { env } from '../env.js';
import { isLoopbackAddress } from './loopback.js';
import type { AuthMethodId } from '../db/sessions.js';

export interface AuthMethod {
  id: AuthMethodId;
  available: boolean;
  /** Why it is unavailable. Shown in the interface rather than only logged. */
  reason?: string;
  /** One line describing what choosing this does. */
  description: string;
}

export interface AuthMethods {
  methods: AuthMethod[];
  /** What a request that names no method will use. */
  default: AuthMethodId;
}

/**
 * The socket peer, not `req.ip`.
 *
 * They agree today, but `req.ip` follows `X-Forwarded-For` the moment anyone
 * enables `trust proxy` -- an ordinary thing to do behind a load balancer --
 * and at that point this check would be trusting a header the caller writes.
 */
export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? undefined);
}

const OAUTH_DESCRIPTION = 'Authorise InfraCanvas on GitHub. Each user signs in as themselves.';
const TOKEN_DESCRIPTION =
  'Use the token already on this machine, from GITHUB_TOKEN or the gh CLI. No app registration.';

export function oauthAvailability(): { available: boolean; reason?: string } {
  const config = env();

  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    return {
      available: false,
      reason:
        'No GitHub OAuth application is configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable this.',
    };
  }

  return { available: true };
}

/**
 * The token method signs the caller in as whoever owns the machine, with the
 * scopes their token already carries. On a laptop that is the point; reachable
 * from a network it hands the operator's repositories to anyone who can open
 * the port.
 */
export function tokenAvailability(req: Request): { available: boolean; reason?: string } {
  if (isLoopbackRequest(req) || env().AUTH_TOKEN_ALLOW_REMOTE) {
    return { available: true };
  }

  return {
    available: false,
    reason:
      'The local token method only accepts requests from this machine, because it signs the ' +
      'caller in as the operator. Set AUTH_TOKEN_ALLOW_REMOTE=true only if every caller is ' +
      'trusted with that access.',
  };
}

export function availableMethods(req: Request): AuthMethods {
  const oauth = oauthAvailability();
  const token = tokenAvailability(req);

  const methods: AuthMethod[] = [
    { id: 'oauth', ...oauth, description: OAUTH_DESCRIPTION },
    { id: 'token', ...token, description: TOKEN_DESCRIPTION },
  ];

  return { methods, default: preferredMethod(req) };
}

/**
 * What to use when the request names nothing.
 *
 * `AUTH_PROVIDER` first, so existing deployments behave exactly as before. Only
 * when that choice is unusable does this fall through, which is the case that
 * used to be a confusing failure: a `token` deployment reached from a browser
 * on another machine, or an `oauth` deployment with no application registered.
 */
export function preferredMethod(req: Request): AuthMethodId {
  const configured = env().AUTH_PROVIDER;

  if (configured === 'oauth' && oauthAvailability().available) return 'oauth';
  if (configured === 'token' && tokenAvailability(req).available) return 'token';

  if (oauthAvailability().available) return 'oauth';
  if (tokenAvailability(req).available) return 'token';

  return configured;
}

export type MethodChoice =
  | { ok: true; method: AuthMethodId }
  | { ok: false; status: number; error: string };

/**
 * Resolve the method for one request.
 *
 * An unavailable method is refused with the reason rather than redirected,
 * because a redirect into a flow that cannot complete is a worse experience
 * than a sentence saying why.
 */
export function chooseMethod(req: Request, requested: unknown): MethodChoice {
  if (requested === undefined || requested === '') {
    const method = preferredMethod(req);
    const availability = method === 'oauth' ? oauthAvailability() : tokenAvailability(req);

    return availability.available
      ? { ok: true, method }
      : { ok: false, status: 503, error: availability.reason as string };
  }

  if (requested !== 'oauth' && requested !== 'token') {
    return {
      ok: false,
      status: 400,
      error: `Unknown sign-in method "${String(requested)}". Use "oauth" or "token".`,
    };
  }

  const availability = requested === 'oauth' ? oauthAvailability() : tokenAvailability(req);

  return availability.available
    ? { ok: true, method: requested }
    : { ok: false, status: 403, error: availability.reason as string };
}
