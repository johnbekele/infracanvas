# Project Development Guidelines

## Workflow & Review Process

- **Phase Reviews**: Always ask for user review after completing each development phase before proceeding to the next
- **Architectural Decisions**: If implementation requires architectural decisions, stop and discuss options with the user before implementing
- **Incremental Development**: Break work into reviewable phases rather than large monolithic changes

## Git & GitHub Configuration

**CRITICAL**: Never use an assistant profile for any git/GitHub operation.

- Use the **`gh` CLI** for all remote operations (issues, pull requests, labels, branches, rulesets).
  It is already authenticated as **johnbekele**, which is the only profile permitted here.
- No GitHub MCP server is configured on this machine. Do not wait for `mcp__github__*` tools; they
  are unavailable and the `gh` CLI is the supported path.
- `gh` reads its token from the OS keyring, which sandboxed processes cannot access. Run `gh`
  commands **outside the sandbox**, otherwise authentication fails with a misleading
  "token in keyring is invalid" error. Verify with `gh api user --jq .login`.
- Use terminal git for local operations only (staging, committing, local branches).
- Do NOT add any AI or assistant co-author attribution to commits. Gate 2 rejects commits carrying
  `Co-Authored-By: Claude`, `Generated with`, or similar trailers.

### Commit identity

This is a personal project. Every commit must be authored by the personal account **johnbekele**:

```
user.name  = John Bekele
user.email = 164889902+johnbekele@users.noreply.github.com
```

- These are set in this repository's local git config, which every worktree shares. **Do not remove
  or "correct" them**, and never fall back to the global config, which carries the Thomson Reuters
  work address `yohans.bekele@thomsonreuters.com`. That address resolves on GitHub to the work
  account `johnbekele6130593`, so a commit made with it attributes personal work to an employer.
- Check before your first commit in a session, and after any `git clone`:
  ```bash
  git config --get user.email   # must be the noreply address above
  ```
- If commits have already been made with the wrong address and are not yet merged, rewrite them
  before the pull request is reviewed:
  ```bash
  git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main
  ```
  Verify with `git log origin/main..HEAD --format='%an <%ae>'`.

## Quality Gates

This repository is governed by a ten-gate system. Details live in `docs/DELIVERY.md`.

- Work begins only on issues labelled `agent-ready` by Gate 0. If a required section of the issue is
  missing, fix the issue first rather than guessing at the contract.
- Every pull request must close an issue, tick the full checklist, and paste real verification
  output. "Tests pass" is not evidence.
- Never bypass a gate with `--no-verify` or an admin merge. If a gate is wrong, change the gate in
  its own pull request so the change is reviewable.

## Pre-Push Checklist

Before pushing any code:

1. `pnpm lint` and fix all issues
2. Write clean, comprehensive tests
3. Run all tests and ensure they pass
4. Fix any failing tests before pushing
5. Review changes for security vulnerabilities
6. **ALWAYS scan for secret leaks** (API keys, tokens, passwords, credentials) before pushing to GitHub

## New Project Setup

When starting a new project:

- **ALWAYS add a `.gitignore` file first** before any commits
- Include common patterns: `.env`, `node_modules/`, `.DS_Store`, `*.log`, credentials, etc.
- Verify no secrets or sensitive files are tracked before initial commit

## Code Quality Standards

### Modularity

- Keep components small and focused - one responsibility per file
- Do NOT pack multiple components in a single file
- Extract reusable logic into separate modules
- Organize files precisely in well-named folders

### TypeScript

- Avoid `any` type unless absolutely necessary
- Use proper type definitions and interfaces
- Prefer strict typing for reliability

### Architecture Principles

- **Reliable**: Robust error handling, graceful degradation
- **Low Latency**: Optimize for performance, minimize unnecessary operations
- **Easy to Use**: Clear APIs, intuitive interfaces
- **Secured**: Follow OWASP guidelines, validate inputs, sanitize outputs
- **Horizontally Scalable**: Stateless design, avoid bottlenecks

## Technology Preferences

- Prefer open source and free solutions
- Use the best algorithms for the problem at hand
- Document trade-offs when multiple options exist

## Repository Organization

- Keep mono repo structure clean and navigable
- Maintain clear folder hierarchy
- Use consistent naming conventions
- Keep AI context clean with precise file organization
- Remove unused code and dependencies

## Folder Structure Guidelines

```
src/
  components/     # UI components (one per file)
  hooks/          # Custom React hooks
  utils/          # Utility functions
  services/       # API and external service integrations
  types/          # TypeScript type definitions
  constants/      # Application constants
  config/         # Configuration files
tests/
  unit/           # Unit tests
  integration/    # Integration tests
docs/             # Documentation
```

## Testing Standards

- Write tests alongside code, not as an afterthought
- Cover edge cases and error scenarios
- Keep tests readable and maintainable
- Use descriptive test names that explain the expected behavior
