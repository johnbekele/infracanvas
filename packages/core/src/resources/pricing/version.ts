import rdsUsEast1 from './rds-us-east-1.json';

/**
 * One identifier for every committed price list, folded into the preview cache
 * keys so that no figure survives a snapshot bump. Content addressing removes
 * the need for invalidation only if the key names everything the figure
 * depended on, and a price is the input most likely to change underneath a
 * cached answer.
 *
 * The list is explicit rather than globbed because a glob does not survive
 * bundling for the browser. `version.test.ts` fails when a price list in this
 * directory is missing from it, so the list cannot silently fall behind.
 */
const SNAPSHOTS: readonly { file: string; priceListVersion: string }[] = [
  { file: 'rds-us-east-1.json', priceListVersion: rdsUsEast1.priceListVersion },
];

export const PRICE_SNAPSHOT_VERSION = SNAPSHOTS.map(
  (snapshot) => `${snapshot.file}@${snapshot.priceListVersion}`
).join('+');

/** The files this version identifier covers, so a test can compare them with what is on disk. */
export function pricedSnapshotFiles(): string[] {
  return SNAPSHOTS.map((snapshot) => snapshot.file).sort();
}
