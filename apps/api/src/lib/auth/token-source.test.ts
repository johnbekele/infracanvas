import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process is mocked so the suite never depends on whether the machine
// running it happens to have gh installed and logged in. A test that passes on
// a laptop and fails in CI for that reason is worse than no test.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const { resolveGitHubToken, InvalidAccountError, NO_TOKEN_GUIDANCE } =
  await import('./token-source.js');

/** Drive the execFile callback the way a successful `gh auth token` would. */
function ghReturns(stdout: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    callback(null, stdout, '');
  });
}

/** Drive it the way a missing binary or logged-out gh would. */
function ghFails(message: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    callback(new Error(message), '', message);
  });
}

describe('resolveGitHubToken', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalAccount = process.env.GITHUB_ACCOUNT;

  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ACCOUNT;
  });

  afterEach(() => {
    restore('GITHUB_TOKEN', originalToken);
    restore('GITHUB_ACCOUNT', originalAccount);
  });

  it('prefers the environment token over the gh cli', async () => {
    process.env.GITHUB_TOKEN = 'ghp_from_env';
    ghReturns('ghp_from_cli');

    const resolved = await resolveGitHubToken();

    expect(resolved).toEqual({ token: 'ghp_from_env', origin: 'env' });
    // An explicit token must win outright, not merely be checked first: a
    // container with GITHUB_TOKEN set should never shell out at all.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('falls back to the gh cli when no environment token is set', async () => {
    ghReturns('ghp_from_cli\n');

    const resolved = await resolveGitHubToken();

    expect(resolved).toEqual({ token: 'ghp_from_cli', origin: 'gh-cli' });
  });

  it('invokes gh without a shell so no argument can become a command', async () => {
    ghReturns('ghp_from_cli');

    await resolveGitHubToken();

    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(options).not.toHaveProperty('shell');
    // A stuck keyring prompt must not hold a request open indefinitely.
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('returns null when neither source yields a token', async () => {
    ghFails('gh: command not found');

    expect(await resolveGitHubToken()).toBeNull();
  });

  it('returns null rather than leaking stderr when gh fails', async () => {
    // gh can echo a token back in some failure modes, so the caller must never
    // receive its output.
    ghFails('failed to read token ghp_leaked_secret from keyring');

    const resolved = await resolveGitHubToken();

    expect(resolved).toBeNull();
    expect(JSON.stringify(resolved)).not.toContain('ghp_leaked_secret');
  });

  it('treats whitespace-only output as no token', async () => {
    ghReturns('   \n  ');

    expect(await resolveGitHubToken()).toBeNull();
  });

  it('ignores an empty environment token instead of using it', async () => {
    process.env.GITHUB_TOKEN = '   ';
    ghReturns('ghp_from_cli');

    // An exported-but-blank variable is a misconfiguration, not an instruction
    // to authenticate with an empty string.
    expect(await resolveGitHubToken()).toEqual({ token: 'ghp_from_cli', origin: 'gh-cli' });
  });

  it('asks gh for the named account when the machine has more than one', () => {
    // Without this, gh answers with whichever account its config calls active,
    // and on a work laptop that is reliably the wrong one. The failure is
    // silent: the token is valid and the session it creates is real, so a
    // repository gets connected as an identity nobody chose.
    process.env.GITHUB_ACCOUNT = 'johnbekele';
    ghReturns('ghp_personal');

    return resolveGitHubToken().then((resolved) => {
      expect(resolved).toEqual({ token: 'ghp_personal', origin: 'gh-cli' });
      expect(execFileMock.mock.calls[0][1]).toEqual(['auth', 'token', '--user', 'johnbekele']);
    });
  });

  it('leaves the account to gh when none is named', async () => {
    ghReturns('ghp_from_cli');

    await resolveGitHubToken();

    expect(execFileMock.mock.calls[0][1]).toEqual(['auth', 'token']);
  });

  it('treats a blank account as none rather than asking for an empty login', async () => {
    process.env.GITHUB_ACCOUNT = '  ';
    ghReturns('ghp_from_cli');

    await resolveGitHubToken();

    expect(execFileMock.mock.calls[0][1]).toEqual(['auth', 'token']);
  });

  it('refuses an account that is not a GitHub login', async () => {
    // A typo here should name the variable that is wrong. Silently falling back
    // to the active account would reintroduce exactly the bug this prevents.
    process.env.GITHUB_ACCOUNT = 'john bekele; rm -rf /';
    ghReturns('ghp_from_cli');

    await expect(resolveGitHubToken()).rejects.toBeInstanceOf(InvalidAccountError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('names both sources in the guidance it gives when there is no token', () => {
    // The message and the resolution order have to agree; one listing the wrong
    // sources is worse than none.
    expect(NO_TOKEN_GUIDANCE).toContain('GITHUB_TOKEN');
    expect(NO_TOKEN_GUIDANCE).toContain('gh auth login');
    expect(NO_TOKEN_GUIDANCE).toContain('AUTH_PROVIDER=oauth');
    expect(NO_TOKEN_GUIDANCE).toContain('GITHUB_ACCOUNT');
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
