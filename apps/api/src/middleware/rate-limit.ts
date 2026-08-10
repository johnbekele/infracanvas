/**
 * Request rate limiting.
 *
 * Built on `express-rate-limit` rather than by hand. Counting requests looks
 * trivial until the details arrive: IPv6 clients get a whole /64 each and must
 * be bucketed by subnet or one host rotates through addresses forever, the
 * `RateLimit` headers are a specified format rather than an invention, and a
 * store that is only swept on a timer keeps every key seen since boot alive
 * until the sweep runs. None of that is worth reimplementing.
 *
 * The store is in-process. That is enough for a single instance and for local
 * use, but it means a limit of 100 becomes 100 *per instance* once this runs
 * behind more than one. Making the limit hold across instances needs a shared
 * store, which is tracked separately; switching to one is a store option here
 * rather than a rewrite.
 */
import { rateLimit } from 'express-rate-limit';

/**
 * Hops of reverse proxy in front of this process.
 *
 * This has to be stated rather than assumed. Trusting `X-Forwarded-For` when
 * nothing sets it lets any caller claim any address and sidestep the limit
 * entirely by varying the header; not trusting it behind a real proxy puts
 * every request in one bucket keyed by the proxy, so the first noisy client
 * locks out everyone. The default of 0 is the safe one: it fails closed, in
 * that it may over-restrict but never lets a caller choose their own key.
 */
export const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10) || 0;

const RATE_LIMITED_BODY = { error: 'Too many requests' };

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    // The `RateLimit` and `RateLimit-Policy` headers from the IETF draft, in
    // place of the older `X-RateLimit-*` set.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
    // The library refuses to start when `trust proxy` is permissive and a
    // forwarded header is present, since that combination is spoofable. The
    // app sets the hop count explicitly, so the check has nothing to catch.
    validate: { trustProxy: TRUST_PROXY_HOPS > 0 ? false : true },
  });
}

/** Sign-in attempts: slow enough to make guessing pointless, generous for a person. */
export const authRateLimit = limiter(15 * 60 * 1000, 20);

/** Ordinary API traffic. */
export const apiRateLimit = limiter(60 * 1000, 100);
