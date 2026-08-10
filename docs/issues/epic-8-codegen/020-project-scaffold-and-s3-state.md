---
title: '[infra] Generated project scaffold with a self-managed S3 state backend'
labels: tier:1, size:m, area:infra, epic:8-codegen
---

### Epic

#9

### Context

`resources.py` from `docs/issues/epic-8-codegen/010-pulumi-python-emitter.md` is not something
Pulumi can run. It needs a project file, an entry point, pinned dependencies, a build recipe, and
somewhere to keep state. This issue produces all of that, and the state decision is the one with
consequences.

**No Pulumi Cloud account.** The default Pulumi backend is Pulumi's hosted service, which means a
user cannot deploy anything until they have created a second account with a third party, and it means
the state describing their infrastructure lives somewhere neither they nor we control. For a tool
whose pitch is "connect your AWS account and press deploy", one signup is already one too many. The
self-managed S3 backend removes that step entirely, and it puts state in the user's own account,
which is also where the resources are, so there is exactly one place to look and one place to revoke.
The cost is that we own the operational details Pulumi Cloud would have handled: bucket layout,
locking, and what a concurrent deploy does. Those are written down below rather than discovered
later.

**KMS for secrets, not a passphrase.** A self-managed backend needs a secrets provider for encrypted
config and for outputs marked secret. `PULUMI_CONFIG_PASSPHRASE` would mean generating a passphrase
per experiment and storing it in our database forever - a long-lived secret whose loss makes a stack
undestroyable and whose leak decrypts state. `awskms://alias/infracanvas-state` uses a key created by
the bootstrap in `docs/issues/epic-9-deploy/020-bootstrap-stack.md`, so the only thing that can
decrypt state is a principal in the user's own account and we store no secret at all.

**Locking is Pulumi's, guarding is ours.** Modern Pulumi CLI locks self-managed backends by default:
it writes a lock object before mutating a stack and refuses to start a second mutation while one
exists. That is a correctness backstop, not a user experience - the second deploy fails with a lock
error several minutes into a CodeBuild run. So the API refuses the second deploy before starting a
build, and the lock is what catches the case the API cannot see, such as a user running `pulumi up`
by hand against the same stack.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```python
# services/brain/src/brain/codegen/backend.py
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BackendConfig:
    state_bucket: str
    region: str
    experiment_id: str
    kms_key_alias: str = "alias/infracanvas-state"

    @property
    def login_url(self) -> str:
        """s3://<bucket>/experiments/<experiment_id>?region=<region>&awssdk=v2"""

    @property
    def secrets_provider(self) -> str:
        """awskms://<alias>?region=<region>"""


PROJECT_NAME = "infracanvas-experiment"
PULUMI_VERSION = "3.148.0"
STALE_LOCK_MINUTES = 90


def stack_name(experiment_id: str) -> str:
    """`exp-` plus the first 12 characters of the experiment id, lowercased."""


# services/brain/src/brain/codegen/scaffold.py
def scaffold_project(
    program: GeneratedFile,
    backend: BackendConfig,
    ctx: EmitContext,
) -> tuple[GeneratedFile, ...]:
    """program plus every supporting file, sorted by path."""
```

The returned tuple is exactly these paths:

| Path                          | Purpose                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `Pulumi.yaml`                 | `name: infracanvas-experiment`, `runtime: python` with `virtualenv: venv` |
| `__main__.py`                 | Four lines: import `resources`, nothing else                              |
| `resources.py`                | The emitted program, passed through unchanged                             |
| `requirements.txt`            | `pulumi==3.148.0`, `pulumi-aws==6.66.2`, exact pins, no ranges            |
| `buildspec.yml`               | CodeBuild recipe, version `0.2`                                           |
| `scripts/run-pulumi.sh`       | Runs one allowlisted Pulumi command; the build's only entry point         |
| `scripts/clear-stale-lock.sh` | Cancels a lock older than the build timeout, and only then                |
| `pyproject.toml`              | ruff and mypy configuration for the generated project                     |
| `.gitignore`                  | `venv/`, `__pycache__/`, `outputs.json`                                   |
| `README.md`                   | How to run this project by hand, including the `pulumi login` line        |

State layout under the bucket the bootstrap creates:

```
s3://infracanvas-state-<accountId>-<region>/
  experiments/<experimentId>/
    .pulumi/
      meta.yaml
      stacks/exp-<id12>.json          # current checkpoint
      history/exp-<id12>-<n>.json     # one per update
      locks/infracanvas-experiment/exp-<id12>/<lockId>.json
      backups/
    outputs.json                      # written by the build's post_build phase
  sources/<experimentId>/<sha256>.zip # build input, uploaded by the API
```

One prefix per experiment rather than one bucket per experiment: bucket names are a global namespace
with a per-account limit, and a prefix is deleted by the destroy path without a bucket-deletion race.

The build recipe is fixed:

```yaml
version: 0.2
env:
  variables:
    PULUMI_SKIP_UPDATE_CHECK: 'true'
    PULUMI_SKIP_CONFIRMATIONS: 'true'
    PULUMI_COMMAND: 'up'
phases:
  install:
    runtime-versions:
      python: 3.12
    commands:
      - curl -fsSL https://get.pulumi.com | sh -s -- --version "$PULUMI_VERSION"
      - export PATH="$HOME/.pulumi/bin:$PATH"
      - python -m venv venv && ./venv/bin/pip install -r requirements.txt
  pre_build:
    commands:
      - pulumi login "$PULUMI_BACKEND_URL"
      # A lock older than the build timeout cannot belong to a running build.
      - ./scripts/clear-stale-lock.sh "$STALE_LOCK_MINUTES"
      - pulumi stack select --create "$PULUMI_STACK_NAME" --secrets-provider "$PULUMI_SECRETS_PROVIDER"
  build:
    commands:
      - ./scripts/run-pulumi.sh "$PULUMI_COMMAND"
```

`run-pulumi.sh` takes one argument and matches it against exactly two accepted values. `up` runs
`pulumi up --yes --non-interactive --refresh`, writes `pulumi stack output --json` to `outputs.json`
and copies it to `s3://$STATE_BUCKET/experiments/$EXPERIMENT_ID/outputs.json`. `destroy` runs
`pulumi destroy --yes --non-interactive` and then `pulumi stack rm --yes` only if the destroy
succeeded. Anything else exits non-zero without running Pulumi at all. The allowlist is the point:
`PULUMI_COMMAND` arrives as a CodeBuild environment override sent by the API, and a value interpolated
straight into a shell line would be a command injection into a container holding the deploy role.

`clear-stale-lock.sh` lists `.pulumi/locks/` and runs `pulumi cancel --yes` only when every lock object
is older than `STALE_LOCK_MINUTES`, which is 90 against a 60-minute CodeBuild timeout. It never cancels
unconditionally, because that would turn Pulumi's protection against two concurrent writers into a race
that the later build always wins.

**Concurrent deploy behaviour.** The API rejects a deploy for an experiment already in `deploying`
with 409 and does not start a build. If a build starts anyway - a hand-run `pulumi up`, or a build
already in flight when the row was updated - the second `pulumi up` exits non-zero during
`pre_build`/`build` with `error: the stack is currently locked by 1 lock(s)` naming the holder's
timestamp and process, the CodeBuild phase fails, and the deployment is recorded as failed with that
message. `pulumi preview` is unaffected by a held lock, so a read-only preview never blocks.

### Files

- CREATE `services/brain/src/brain/codegen/backend.py`
- CREATE `services/brain/src/brain/codegen/scaffold.py`
- CREATE `services/brain/src/brain/codegen/templates/buildspec.yml.tmpl`
- CREATE `services/brain/src/brain/codegen/templates/run-pulumi.sh`
- CREATE `services/brain/src/brain/codegen/templates/clear-stale-lock.sh`
- CREATE `services/brain/src/brain/codegen/templates/README.md.tmpl`
- CREATE `services/brain/tests/codegen/test_backend.py`
- CREATE `services/brain/tests/codegen/test_scaffold.py`
- MODIFY `services/brain/pyproject.toml` - add `pyyaml` to the dev extra so tests can parse the
  emitted buildspec, and include `src/brain/codegen/templates` in the wheel

### Acceptance Criteria

- [ ] `login_url` is an `s3://` URL scoped to `experiments/<experimentId>`, never the bucket root
- [ ] `secrets_provider` is an `awskms://` URL and no passphrase appears in any emitted file
- [ ] `scaffold_project` returns the ten paths above and nothing else, sorted by path
- [ ] `requirements.txt` pins exact versions with `==`, so two deploys a month apart install the same
      Pulumi
- [ ] The emitted `buildspec.yml` parses as YAML and declares `version: 0.2`
- [ ] `clear-stale-lock.sh` runs `pulumi cancel` only when every lock object is older than 90 minutes
- [ ] `run-pulumi.sh` accepts only `up` and `destroy`, and exits non-zero on anything else without
      invoking Pulumi
- [ ] `stack_name` is stable for a given experiment id and contains no characters Pulumi rejects
- [ ] No emitted file contains a timestamp, hostname, or absolute path from the generating machine
- [ ] The emitted `README.md` contains the exact `pulumi login` command for that experiment's prefix

### Required Tests

- `login url is scoped to the experiment prefix`
- `secrets provider is a kms alias url`
- `no emitted file contains a config passphrase`
- `scaffold returns exactly the expected paths in sorted order`
- `requirements are pinned to exact versions`
- `buildspec parses as yaml and declares version 0.2`
- `stale lock script leaves a fresh lock alone`
- `stale lock script cancels a lock older than the build timeout`
- `run pulumi script rejects a command outside the allowlist`
- `stack name is stable and contains only permitted characters`

### Performance Budget

Scaffolding adds under 20ms to a generation, measured with `pytest --durations=10`. The state
checkpoint for a 200-resource stack stays under 2MB, which is what keeps a `pulumi up` from spending
its time transferring state; measured once against the fixture stack in the manual pre-release check.

### Out of Scope

- Do not create the state bucket, the KMS key, or the CodeBuild project; the bootstrap stack does
- Do not call `pulumi login`, `StartBuild`, or any AWS API from the brain; the API service drives the
  deploy
- Do not add hash-pinning to `requirements.txt`; that needs a resolver run per generation and is a
  separate decision
- Do not support the Pulumi Cloud backend as an option, even behind a flag
- Do not change `packages/core/src/codegen/pulumi.ts`, which emits its own unrelated `Pulumi.yaml`

### Dependencies

Blocked by #3, and by the emitter in `docs/issues/epic-8-codegen/010-pulumi-python-emitter.md`. The
bucket and key it references are created by `docs/issues/epic-9-deploy/020-bootstrap-stack.md`, which
can land in either order because the names are derived, not discovered.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/codegen/test_scaffold.py tests/codegen/test_backend.py -v
uv run --directory services/brain pytest
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
