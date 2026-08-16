/**
 * Node ships its own CA bundle, which diverges from the OS store on macOS and
 * behind a corporate TLS proxy, so an outbound call to an LLM provider fails
 * here while the same call from a browser on the same machine succeeds. Merging
 * both stores is what `node --use-system-ca` does, and doing it in process means
 * the flag cannot be forgotten by whoever starts the server.
 *
 * Reached through a capability check rather than a static import because the two
 * functions arrived in Node 22.15 and the repository's `@types/node` predates
 * them: importing them by name fails to compile, and requiring a newer Node to
 * run the API would be a large cost for a workaround.
 */
import * as tls from 'node:tls';

interface SystemCaCapable {
  getCACertificates?(kind: 'default' | 'system'): string[];
  setDefaultCACertificates?(certificates: readonly string[]): void;
}

export function useSystemCertificateAuthorities(): boolean {
  const runtime = tls as SystemCaCapable;
  if (runtime.getCACertificates === undefined || runtime.setDefaultCACertificates === undefined) {
    return false;
  }

  try {
    runtime.setDefaultCACertificates([
      ...runtime.getCACertificates('default'),
      ...runtime.getCACertificates('system'),
    ]);
    return true;
  } catch {
    // A platform with no system store keeps Node's bundle, which is the
    // behaviour every environment had before this file existed.
    return false;
  }
}
