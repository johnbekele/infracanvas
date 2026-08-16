#!/usr/bin/env node
/**
 * Asserts the lockfile has no analytics or telemetry package.
 *
 * "We do not phone home" is only worth writing if CI fails when a telemetry
 * dependency enters the tree.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Package name substrings that indicate product analytics or phone-home SDKs. */
export const FORBIDDEN_TELEMETRY = [
  'telemetry',
  'analytics',
  'posthog',
  'mixpanel',
  'amplitude',
  'segment',
  'heap-analytics',
  '@sentry/',
  'sentry-sdk',
  'newrelic',
  'datadog-rum',
  '@datadog/browser-rum',
  'applicationinsights',
  'opencensus',
  '@fullstory/',
  'logrocket',
  'hotjar',
  'plausible-tracker',
];

/**
 * @param {string} lockfileText
 * @returns {string[]} matching package identity strings
 */
export function findTelemetryPackages(lockfileText) {
  const hits = new Set();
  // pnpm lockfile v6/v9: package keys look like `/name@version:` or `name@version:`.
  const keyRe = /(?:^|\n)(?:\s{2})?(?:['"]?)(\/?@?[\w.-]+(?:\/[\w.-]+)?)[@/]/gm;

  for (const match of lockfileText.matchAll(keyRe)) {
    const name = match[1].replace(/^\//, '').toLowerCase();
    for (const needle of FORBIDDEN_TELEMETRY) {
      if (name.includes(needle.toLowerCase())) {
        hits.add(name);
      }
    }
  }

  // Also scan importers' dependency declaration lines for a direct hit.
  for (const needle of FORBIDDEN_TELEMETRY) {
    const re = new RegExp(
      `(?:^|\\n)\\s+['"]?[^\\s'"]*${escapeRegExp(needle)}[^\\s'"]*['"]?\\s*:`,
      'i'
    );
    if (re.test(lockfileText)) {
      hits.add(needle);
    }
  }

  return [...hits].sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`ok - ${name}`);
}

function selfTest() {
  const clean = `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      express:\n        specifier: ^4.18.2\n        version: 4.18.2\n`;
  assert(
    'the lockfile contains no analytics or telemetry package',
    findTelemetryPackages(clean).length === 0
  );

  const dirty = `lockfileVersion: '9.0'\n\npackages:\n  'posthog-js@1.0.0':\n    resolution: {integrity: sha512-fake}\n`;
  assert(
    'a telemetry package in the lockfile is detected',
    findTelemetryPackages(dirty).some((h) => h.includes('posthog'))
  );
}

function main() {
  selfTest();

  const lockPath = join(ROOT, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    console.error('pnpm-lock.yaml not found');
    return 1;
  }

  const hits = findTelemetryPackages(readFileSync(lockPath, 'utf8'));
  if (hits.length) {
    for (const hit of hits) {
      console.error(`telemetry/analytics package in lockfile: ${hit}`);
    }
    return 1;
  }

  console.log('ok - lockfile contains no analytics or telemetry package');
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
