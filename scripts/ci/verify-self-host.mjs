#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDocLinks } from './check-doc-links.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DOC = 'docs/SELF_HOST.md';
const SCRATCH_PREFIX = 'infracanvas-self-host-';
const REQUIRED_PREREQUISITES = new Set([
  'node',
  'pnpm',
  'docker',
  'docker compose',
  'rustc',
  'python3',
  'dbmate',
]);
const OPTIONAL_PREREQUISITES = new Set(['uv']);
const PNPM_BUILT_INS = new Set([
  'add',
  'approve-builds',
  'config',
  'dlx',
  'env',
  'exec',
  'i',
  'install',
  'remove',
  'run',
  'store',
  'turbo',
]);
const COPY_EXCLUDED_DIRS = new Set([
  '.git',
  '.turbo',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

function parseArgs(argv) {
  const options = {
    doc: DEFAULT_DOC,
    keep: false,
    selfTest: false,
    linksOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--doc') {
      const value = argv[index + 1];
      if (!value) throw new Error('--doc requires a path');
      options.doc = value;
      index += 1;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--self-test') {
      options.selfTest = true;
    } else if (arg === '--links-only') {
      options.linksOnly = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function extractVerifyBlocks(docPath, repoRoot = REPO_ROOT) {
  const markdown = readFileSync(path.resolve(repoRoot, docPath), 'utf8');
  const lines = markdown.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '```bash verify') continue;

    const startLine = index + 1;
    const body = [];
    index += 1;

    while (index < lines.length && lines[index].trim() !== '```') {
      body.push(lines[index]);
      index += 1;
    }

    if (index === lines.length) {
      throw new Error(`${docPath}:${startLine}: unterminated bash verify block`);
    }

    blocks.push({ line: startLine, content: body.join('\n') });
  }

  return blocks;
}

function walkFiles(root, shouldInclude) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const parts = relative.split(path.sep);
      if (parts.some((part) => COPY_EXCLUDED_DIRS.has(part))) continue;

      if (entry.isDirectory()) {
        visit(absolute);
      } else if (shouldInclude(absolute)) {
        files.push(absolute);
      }
    }
  }

  visit(root);
  return files;
}

function parseEnvExampleVariables(filePath) {
  const variables = [];
  const lines = readFileSync(filePath, 'utf8').split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (match) variables.push(match[1]);
  }

  return variables;
}

function collectEnvExampleVariables(repoRoot = REPO_ROOT) {
  const variables = new Map();
  const exampleFiles = walkFiles(repoRoot, (file) => file.endsWith('.env.example'));

  for (const file of exampleFiles) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    for (const variable of parseEnvExampleVariables(file)) {
      const paths = variables.get(variable) ?? [];
      paths.push(relative);
      variables.set(variable, paths);
    }
  }

  return variables;
}

function extractDocumentVariables(markdown) {
  const variables = new Set();

  for (const match of markdown.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
    variables.add(match[1]);
  }

  for (const line of markdown.split('\n')) {
    const assignment = line.match(/(?:^|\s)(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (assignment) variables.add(assignment[1]);
  }

  return variables;
}

function checkVariables(
  docPath,
  repoRoot = REPO_ROOT,
  exampleVariables = collectEnvExampleVariables(repoRoot)
) {
  const markdown = readFileSync(path.resolve(repoRoot, docPath), 'utf8');
  const documented = extractDocumentVariables(markdown);
  const exampleNames = new Set(exampleVariables.keys());
  const failures = [];

  for (const variable of documented) {
    if (!exampleNames.has(variable)) {
      failures.push(
        `${docPath}: environment variable is documented but absent from examples: ${variable}`
      );
    }
  }

  for (const variable of exampleNames) {
    if (!documented.has(variable)) {
      const files = exampleVariables.get(variable).join(', ');
      failures.push(
        `${docPath}: environment variable from ${files} is not documented: ${variable}`
      );
    }
  }

  return failures;
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function parsePrerequisites(docPath, repoRoot = REPO_ROOT) {
  const markdown = readFileSync(path.resolve(repoRoot, docPath), 'utf8');
  const prerequisites = new Map();

  for (const line of markdown.split('\n')) {
    const cells = splitTableRow(line);
    if (!cells || cells.length < 2) continue;

    const [toolCell, versionCell] = cells;
    if (/^-+$/.test(toolCell.replaceAll(' ', ''))) continue;

    const tool = toolCell.match(/`([^`]+)`/)?.[1];
    const expected = versionCell.match(/`([^`]+)`/)?.[1];
    if (tool && expected) prerequisites.set(tool, expected);
  }

  return prerequisites;
}

function commandForTool(tool) {
  if (tool === 'docker compose') return ['docker', ['compose', 'version']];

  const commands = {
    dbmate: ['dbmate', ['--version']],
    docker: ['docker', ['--version']],
    node: ['node', ['--version']],
    pnpm: ['pnpm', ['--version']],
    python3: ['python3', ['--version']],
    rustc: ['rustc', ['--version']],
    uv: ['uv', ['--version']],
  };

  return commands[tool] ?? null;
}

function defaultRunner(binary, args) {
  return spawnSync(binary, args, { encoding: 'utf8' });
}

function parseVersion(output) {
  return output.match(/\d+(?:\.\d+){0,2}/)?.[0] ?? null;
}

function versionMatches(actual, expected) {
  if (expected.endsWith('.x')) {
    return actual.startsWith(`${expected.slice(0, -1)}`);
  }

  return actual === expected;
}

function checkPrerequisites(docPath, repoRoot = REPO_ROOT, runner = defaultRunner) {
  const prerequisites = parsePrerequisites(docPath, repoRoot);
  const failures = [];

  for (const required of REQUIRED_PREREQUISITES) {
    if (!prerequisites.has(required)) {
      failures.push(`${docPath}: missing pinned prerequisite version for ${required}`);
    }
  }

  for (const [tool, expected] of prerequisites) {
    if (!REQUIRED_PREREQUISITES.has(tool) && !OPTIONAL_PREREQUISITES.has(tool)) continue;

    const command = commandForTool(tool);
    if (!command) {
      failures.push(`${docPath}: no assertion command is defined for prerequisite ${tool}`);
      continue;
    }

    const [binary, args] = command;
    const result = runner(binary, args);
    if (result.error || result.status !== 0) {
      failures.push(`${docPath}: ${tool} prerequisite command failed: ${binary} ${args.join(' ')}`);
      continue;
    }

    const actual = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (!actual || !versionMatches(actual, expected)) {
      failures.push(`${docPath}: ${tool} expected ${expected}, got ${actual ?? 'unknown'}`);
    }
  }

  return failures;
}

function packageJsonFiles(repoRoot = REPO_ROOT) {
  return walkFiles(repoRoot, (file) => path.basename(file) === 'package.json');
}

function workspaceScripts(repoRoot = REPO_ROOT) {
  const scripts = new Set();

  for (const file of packageJsonFiles(repoRoot)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    for (const script of Object.keys(parsed.scripts ?? {})) scripts.add(script);
  }

  return scripts;
}

function shellTokens(line) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;

  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }

  return tokens;
}

function stripLeadingAssignments(line) {
  let command = line.trim();
  const assignment = /^(?:[A-Z][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*)+/;
  const match = command.match(assignment);
  if (match) command = command.slice(match[0].length).trim();
  return command;
}

function pnpmScriptFromLine(line) {
  const command = stripLeadingAssignments(line);
  if (!command.startsWith('pnpm ')) return null;

  const tokens = shellTokens(command);
  let index = 1;

  while (tokens[index]?.startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (
      option === '--filter' ||
      option === '-F' ||
      option === '--dir' ||
      option === '-C' ||
      option === '--workspace-root'
    ) {
      index += 1;
    }
  }

  const commandToken = tokens[index];
  if (!commandToken) return null;
  if (commandToken === 'run') return tokens[index + 1] ?? null;
  if (PNPM_BUILT_INS.has(commandToken)) return null;
  return commandToken;
}

function checkPnpmScripts(docPath, repoRoot = REPO_ROOT) {
  const availableScripts = workspaceScripts(repoRoot);
  const failures = [];

  for (const block of extractVerifyBlocks(docPath, repoRoot)) {
    for (const line of block.content.split('\n')) {
      const script = pnpmScriptFromLine(line);
      if (script && !availableScripts.has(script)) {
        failures.push(
          `${docPath}:${block.line}: pnpm script is not defined in any package.json: ${script}`
        );
      }
    }
  }

  return failures;
}

function staticChecks(docPath, repoRoot = REPO_ROOT) {
  const failures = [];
  const blocks = extractVerifyBlocks(docPath, repoRoot);

  if (blocks.length === 0) {
    failures.push(`${docPath}: no bash verify blocks found`);
  }

  failures.push(
    ...checkDocLinks([docPath], repoRoot).map((link) => {
      return `${link.filePath}:${link.line}: relative link target does not exist: ${link.target}`;
    })
  );
  failures.push(...checkVariables(docPath, repoRoot));
  failures.push(...checkPnpmScripts(docPath, repoRoot));
  failures.push(...checkPrerequisites(docPath, repoRoot));

  return failures;
}

function linkAndVariableChecks(docPath, repoRoot = REPO_ROOT) {
  return [
    ...checkDocLinks([docPath], repoRoot).map((link) => {
      return `${link.filePath}:${link.line}: relative link target does not exist: ${link.target}`;
    }),
    ...checkVariables(docPath, repoRoot),
  ];
}

function shouldCopy(relativePath) {
  if (relativePath === '') return true;

  const parts = relativePath.split(path.sep);
  if (parts.some((part) => COPY_EXCLUDED_DIRS.has(part))) return false;

  const basename = parts.at(-1);
  if (basename === '.DS_Store') return false;
  if (basename === '.env') return false;
  if (basename === '.env.local') return false;
  if (basename?.endsWith('.log')) return false;
  if (basename?.endsWith('.pid')) return false;

  return true;
}

function copyRepository(sourceRoot, scratchRoot) {
  cpSync(sourceRoot, scratchRoot, {
    recursive: true,
    dereference: false,
    filter(source) {
      return shouldCopy(path.relative(sourceRoot, source));
    },
  });
}

function createScratchCopy(sourceRoot = REPO_ROOT) {
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  rmSync(scratchRoot, { recursive: true, force: true });
  mkdirSync(scratchRoot, { recursive: true });
  copyRepository(sourceRoot, scratchRoot);
  return scratchRoot;
}

function writeExecutionScript(workdir, docPath, blocks) {
  const scriptPath = path.join(workdir, '.self-host-run.sh');
  const body = [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    '__self_host_line=0',
    'trap \'status=$?; if [ "$status" -ne 0 ]; then echo "$SELF_HOST_DOC:$__self_host_line: verify block failed with exit code $status" >&2; fi; exit $status\' EXIT',
    '',
  ];

  for (const block of blocks) {
    body.push(`__self_host_line=${block.line}`);
    body.push(`printf '\\n==> %s:%s\\n' "$SELF_HOST_DOC" "$__self_host_line"`);
    body.push(block.content);
    body.push('');
  }

  writeFileSync(scriptPath, `${body.join('\n')}\n`, { mode: 0o755 });
  return scriptPath;
}

function executeVerifyBlocks(docPath, workdir, blocks, env, stdio = 'inherit') {
  const scriptPath = writeExecutionScript(workdir, docPath, blocks);
  return spawnSync('bash', [scriptPath], {
    cwd: workdir,
    env: {
      ...process.env,
      ...env,
      BROWSER: 'none',
      CI: '1',
      SELF_HOST_DOC: docPath,
      UV_CACHE_DIR: path.join(workdir, '.self-host-uv-cache'),
    },
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    stdio,
  });
}

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0) return [];

  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

function killTree(pid, rows = processRows(), signal = 'SIGTERM') {
  for (const child of rows.filter((row) => row.ppid === pid)) {
    killTree(child.pid, rows, signal);
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The process may already have exited after its parent received SIGTERM.
  }
}

function cleanupProcesses(workdir) {
  const pidDir = path.join(workdir, '.self-host');
  if (!existsSync(pidDir)) return;

  for (const entry of readdirSync(pidDir)) {
    if (!entry.endsWith('.pid')) continue;

    const pid = Number(readFileSync(path.join(pidDir, entry), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) killTree(pid);
  }
}

function cleanupDocker(workdir, projectName) {
  const dockerNamePath = path.join(workdir, '.self-host', 'docker-name');
  const dockerName = existsSync(dockerNamePath)
    ? readFileSync(dockerNamePath, 'utf8').trim()
    : projectName;

  const containers = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=infracanvas.self-host=${dockerName}`],
    { encoding: 'utf8' }
  );
  const containerIds = containers.stdout?.trim().split('\n').filter(Boolean) ?? [];
  if (containerIds.length > 0) {
    spawnSync('docker', ['rm', '-f', ...containerIds], { stdio: 'inherit' });
  }

  spawnSync('docker', ['rm', '-f', `${dockerName}-postgres`], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', `${dockerName}-postgres-data`], { stdio: 'inherit' });
  spawnSync('docker', ['compose', 'down', '-v', '--remove-orphans'], {
    cwd: workdir,
    env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
    stdio: 'inherit',
  });
}

function cleanupScratch(workdir, projectName) {
  cleanupProcesses(workdir);
  cleanupDocker(workdir, projectName);
  rmSync(workdir, { recursive: true, force: true });
}

function runGuide(options) {
  if (options.linksOnly) {
    const failures = linkAndVariableChecks(options.doc);
    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      return 1;
    }

    console.log('Self-host guide link and variable checks passed.');
    return 0;
  }

  const staticFailures = staticChecks(options.doc);
  if (staticFailures.length > 0) {
    for (const failure of staticFailures) console.error(failure);
    return 1;
  }

  const scratchRoot = createScratchCopy();
  const projectName = `${SCRATCH_PREFIX}${process.pid}`;
  console.log(`Executing ${options.doc} in ${scratchRoot}`);

  const blocks = extractVerifyBlocks(options.doc, scratchRoot);
  const result = executeVerifyBlocks(options.doc, scratchRoot, blocks, {
    COMPOSE_PROJECT_NAME: projectName,
  });

  if (options.keep) {
    console.log(`Keeping self-host scratch directory and containers: ${scratchRoot}`);
  } else {
    cleanupScratch(scratchRoot, projectName);
  }

  return result.status === 0 ? 0 : 1;
}

function assertSelfTest(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }

  return true;
}

function fixturePath(name) {
  return `scripts/ci/fixtures/self-host/${name}`;
}

function withTempDoc(contents, fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'self-host-test-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'fixture.md'), contents);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'echo dev' } }));
  writeFileSync(
    path.join(root, 'apps', 'api', '.env.example'),
    'DATABASE_URL=postgres://example\n'
  );

  try {
    return fn(root, 'docs/fixture.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSelfTests() {
  const tests = [
    assertSelfTest('extracts every verify block in document order', () => {
      const blocks = extractVerifyBlocks(fixturePath('passing.md'));
      const commands = blocks.map((block) => block.content.trim());
      if (commands.join('|') !== 'echo first|echo second') {
        throw new Error(`unexpected verify block order: ${commands.join('|')}`);
      }
    }),
    assertSelfTest('fails naming the document line when a block exits non zero', () => {
      const doc = fixturePath('failing-block.md');
      const root = REPO_ROOT;
      const blocks = extractVerifyBlocks(doc, root);
      const result = executeVerifyBlocks(doc, root, blocks, {}, 'pipe');
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status === 0) throw new Error('failing fixture exited 0');
      if (!output.includes(`${doc}:5: verify block failed`)) {
        throw new Error(`failure did not name fixture line 5:\n${output}`);
      }
    }),
    assertSelfTest(
      'fails when the guide names a variable absent from the example environment files',
      () => {
        const doc = fixturePath('undocumented-variable.md');
        const allowed = new Map([['DATABASE_URL', ['fixture.env.example']]]);
        const failures = checkVariables(doc, REPO_ROOT, allowed);
        if (!failures.some((failure) => failure.includes('NOT_IN_EXAMPLE'))) {
          throw new Error(`expected undocumented variable failure, got ${failures.join('\n')}`);
        }
      }
    ),
    assertSelfTest('fails when the guide invokes a pnpm script that no package defines', () => {
      withTempDoc(
        [
          '# fixture',
          '',
          '| Tool | Version |',
          '| --- | --- |',
          '| `node` | `1.x` |',
          '',
          '```bash verify',
          'pnpm missing-script',
          '```',
          '',
        ].join('\n'),
        (root, doc) => {
          const failures = checkPnpmScripts(doc, root);
          if (!failures.some((failure) => failure.includes('missing-script'))) {
            throw new Error(`expected missing pnpm script failure, got ${failures.join('\n')}`);
          }
        }
      );
    }),
    assertSelfTest('fails when a relative link in the guide has no target file', () => {
      const failures = checkDocLinks([fixturePath('broken-link.md')], REPO_ROOT);
      if (!failures.some((failure) => failure.target === 'docs/does-not-exist.md')) {
        throw new Error('expected broken relative link failure');
      }
    }),
    assertSelfTest('asserts the pinned prerequisite versions and fails on a mismatch', () => {
      withTempDoc(
        [
          '# fixture',
          '',
          '| Tool | Version |',
          '| --- | --- |',
          '| `node` | `99.x` |',
          '| `pnpm` | `99.x` |',
          '| `docker` | `99.x` |',
          '| `docker compose` | `99.x` |',
          '| `rustc` | `99.x` |',
          '| `python3` | `99.x` |',
          '| `dbmate` | `99.x` |',
          '',
          '```bash verify',
          'echo ok',
          '```',
          '',
        ].join('\n'),
        (root, doc) => {
          const failures = checkPrerequisites(doc, root, () => ({
            status: 0,
            stdout: '1.2.3',
            stderr: '',
          }));
          if (!failures.some((failure) => failure.includes('expected 99.x, got 1.2.3'))) {
            throw new Error(`expected prerequisite mismatch, got ${failures.join('\n')}`);
          }
        }
      );
    }),
    assertSelfTest('removes the containers and scratch clone it created', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'self-host-source-'));
      writeFileSync(path.join(root, 'README.md'), '# scratch\n');
      const scratch = createScratchCopy(root);
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      if (existsSync(scratch)) throw new Error(`scratch directory still exists: ${scratch}`);
    }),
    assertSelfTest('completes the whole guide from a clean clone in the nightly job', () => {
      const nightly = readFileSync(path.join(REPO_ROOT, '.github/workflows/nightly.yml'), 'utf8');
      if (!/^\s*self-host:/m.test(nightly))
        throw new Error('nightly workflow has no self-host job');
      if (!nightly.includes('node scripts/ci/verify-self-host.mjs')) {
        throw new Error('nightly self-host job does not run the verifier');
      }
    }),
    assertSelfTest(
      'reports every service health endpoint as healthy after following only the guide',
      () => {
        const guide = readFileSync(path.join(REPO_ROOT, DEFAULT_DOC), 'utf8');
        for (const expected of [
          '.self-host/api-url',
          '.self-host/web-url',
          '.self-host/brain-url',
        ]) {
          if (!guide.includes(expected)) throw new Error(`guide does not verify ${expected}`);
        }
        if ((guide.match(/\/health/g) ?? []).length < 3) {
          throw new Error('guide does not verify three health endpoints');
        }
      }
    ),
  ];

  return tests.every(Boolean) ? 0 : 1;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.selfTest) return runSelfTests();
  return runGuide(options);
}

process.exit(main());
