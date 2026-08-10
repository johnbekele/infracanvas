---
title: '[ci] Self-host guide verified by following it from a clean clone'
labels: tier:3, size:m, area:ci, epic:12-launch
---

### Epic

#13

### Context

A self-host guide that nobody has executed is a guess about the software. This repository has already
paid for that twice: `docs/issues/epic-0-delivery/140-api-starts-from-a-fresh-clone.md` and
`docs/issues/epic-0-delivery/150-dev-servers-start-from-a-clean-tree.md` both exist because documented
start-up commands were true when they were written and quietly stopped being true. Writing a longer
document does not fix that; executing the document does.

So the guide is written as the input to a script. Every command a reader has to run lives in a fenced
block tagged `bash verify`, and `scripts/ci/verify-self-host.mjs` extracts those blocks in document
order and runs them, in sequence, against a scratch clone. Prose that is not in such a block is
explanation only and cannot make a claim about how the software starts. When a block fails, the script
names the document line the block came from, so the fix lands in the guide rather than in someone's
shell history.

Extracting the commands from the document was chosen over keeping a parallel setup script. A parallel
script drifts, and drifts in the worst direction: the script keeps working because CI runs it, while the
document the human reads rots unobserved. Running the document means the human-readable artefact is the
tested one.

A pre-release manual checklist was also rejected. It is skipped exactly when a release is urgent, which
is exactly when a broken first-run experience costs the most.

The script runs in `.github/workflows/nightly.yml` rather than on every pull request. It pulls container
images, runs migrations, and starts every service, which is minutes rather than seconds, and the guide
breaks through drift over time rather than through a single diff. A nightly failure names the commit range
that broke it, which is enough.

The guide also owes two checks that are not about running commands: every environment variable it names
exists in the example environment files and vice versa, and every relative link it contains resolves to a
file that is present. Both are places where a guide fails a new contributor while looking complete.

### Contract

`docs/SELF_HOST.md`, in this order, because the order is the thing being tested:

```
1. Prerequisites            - pinned versions of Node, pnpm, Docker, Rust, Python, dbmate; asserted, not suggested
2. Clone and install
3. Start Postgres and apply migrations
4. Configure the environment - every required variable, what it is for, and how to obtain it
5. Start the services        - api, web, brain
6. Verify                    - one command per service with the response to expect
7. Bring your own keys       - optional model credentials, and what works without them
8. Troubleshooting           - each symptom mapped to its cause
```

Executable blocks are tagged so the extractor can find them, and only those blocks run:

````markdown
```bash verify
pnpm install --frozen-lockfile
```
````

```
node scripts/ci/verify-self-host.mjs [options]

  --doc <path>     document to execute            (default docs/SELF_HOST.md)
  --keep           keep the scratch clone and containers on exit
  --self-test      run the extractor cases against scripts/ci/fixtures/self-host/
  --links-only     run the link and variable checks without executing any block

Exit codes: 0 all blocks passed; 1 a block failed, a link is broken, or a variable
is undocumented. Failures print the document path and line of the offending block.
```

```
node scripts/ci/check-doc-links.mjs <file>...

  Resolves every relative markdown link against the repository root and exits 1
  naming each target that does not exist. Reused by
  docs/issues/epic-12-launch/040-security-policy.md.
```

The nightly job:

```yaml
# .github/workflows/nightly.yml
self-host:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - run: node scripts/ci/verify-self-host.mjs
```

### Files

- CREATE `docs/SELF_HOST.md`
- CREATE `scripts/ci/verify-self-host.mjs`
- CREATE `scripts/ci/check-doc-links.mjs`
- CREATE `scripts/ci/fixtures/self-host/passing.md`
- CREATE `scripts/ci/fixtures/self-host/failing-block.md`
- CREATE `scripts/ci/fixtures/self-host/broken-link.md`
- CREATE `scripts/ci/fixtures/self-host/undocumented-variable.md`
- MODIFY `.github/workflows/nightly.yml` - add the `self-host` job
- MODIFY `README.md` - link to the guide instead of repeating its commands

### Acceptance Criteria

- [ ] Every command a reader must run appears in a `bash verify` block, so nothing is documented that is not executed
- [ ] `node scripts/ci/verify-self-host.mjs` exits 0 on a clean clone and non-zero when any block fails
- [ ] A failing block is reported with the document path and the line number it came from
- [ ] Every variable the guide names exists in the example environment files, and every variable in those files is named in the guide
- [ ] Every relative link in the guide resolves to a file present in the repository
- [ ] Every `pnpm` script the guide invokes exists in some workspace `package.json`
- [ ] The prerequisite versions in the guide are asserted by the script, not merely listed
- [ ] The nightly workflow runs the script and fails the run when the guide has gone stale
- [ ] The script removes the containers, volumes, and scratch clone it created unless `--keep` is passed
- [ ] Following only the documented commands leaves the API, web, and brain health endpoints reporting healthy

### Required Tests

- `extracts every verify block in document order`
- `fails naming the document line when a block exits non zero`
- `fails when the guide names a variable absent from the example environment files`
- `fails when the guide invokes a pnpm script that no package defines`
- `fails when a relative link in the guide has no target file`
- `asserts the pinned prerequisite versions and fails on a mismatch`
- `removes the containers and scratch clone it created`
- `completes the whole guide from a clean clone in the nightly job`
- `reports every service health endpoint as healthy after following only the guide`

### Performance Budget

n/a

### Out of Scope

- Do not add a `docker compose` profile, a devcontainer, or a one-command installer; the guide documents the existing commands
- Do not change how the API, web, or brain services read configuration in order to shorten the guide; fix the guide or file the code change separately
- Do not run this script in Gate 3 or on pull requests; it belongs in nightly because it pulls images and starts services
- Do not rewrite `docs/DELIVERY.md` or the gate documentation
- Do not document deployment to a hosting provider; this guide covers self-hosting only

### Dependencies

Blocked by #1: the documented start-up commands depend on the fixes in
`docs/issues/epic-0-delivery/140-api-starts-from-a-fresh-clone.md` and
`docs/issues/epic-0-delivery/150-dev-servers-start-from-a-clean-tree.md`.

### Verification

```bash
node scripts/ci/verify-self-host.mjs --self-test
node scripts/ci/check-doc-links.mjs docs/SELF_HOST.md README.md
node scripts/ci/verify-self-host.mjs --links-only
node scripts/ci/verify-self-host.mjs
pnpm lint
```

### Risk Tier

tier:3 - docs or tests only

### Size

size:m - 200 to 600 lines
