// Deciding whether a request came from this machine.
//
// Its own module because it is the one thing standing between the local token
// provider and handing the operator's GitHub account to anyone who can reach
// the port. That deserves to be tested directly rather than through a route.

/**
 * True when `address` is a loopback address.
 *
 * Handles the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) that a dual-stack
 * listener reports for an IPv4 loopback connection, and the whole `127.0.0.0/8`
 * range rather than `127.0.0.1` alone, since every address in it is loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;

  const normalised = address.startsWith('::ffff:') ? address.slice(7) : address;

  if (normalised === '::1') return true;

  // Match 127.x.x.x exactly, so a routable address that merely starts with
  // those digits -- 127.0.0.1.example.com, or 1270.0.0.1 -- is not accepted.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalised);
}
