---
title: '[infra] Pulumi AWS Python emitter driven by the Resource Contract'
labels: tier:1, size:m, area:infra, epic:8-codegen
---

### Epic

#9

### Context

This is the point where an architecture stops being a document and becomes something that can create
real AWS resources and a real bill. Everything downstream - validation, deployment, destruction,
cost measurement - reads what this code writes, so the input it trusts and the language it targets
are both decisions worth arguing about once and then not revisiting.

**Generated from the IR, not from the canvas.** The existing generator in
`packages/core/src/codegen/pulumi.ts` takes React Flow nodes: `ServiceNodeData` with a free-form
`properties` bag, plus `position` coordinates that mean nothing to AWS. Nothing validates that bag,
so an unknown property is silently dropped and a missing one becomes a hardcoded default buried in a
template string. Worse, the canvas is a UI artefact: the brain proposes architectures without a
browser being open, and an architecture that can only be deployed after a human has dragged it onto
a canvas cannot be deployed by an agent at all. The IR is normalised, versioned, validated against
`packages/ir-schema`, and already stored on `experiments.ir`, so generating from it means the same
bytes that were reviewed are the bytes that get emitted.

**Python, not the existing TypeScript path.** Two reasons, and neither is a preference about
language. The first is where the code has to live: Gate 7 derives risk tier from paths, and
`services/brain/src/brain/codegen/` is already in its tier-1 list, so a generator written there gets
a security review on every change automatically, while one written in `packages/core` gets tier 2.
The second is validation. The gate in `docs/issues/epic-8-codegen/030-generated-code-validation.md`
has to run ruff, mypy, and checkov over the emitted project and refuse to hand back code that fails.
Those are Python tools, already installed for this service by #30, and emitting Python means the
validator can parse and type-check its own output rather than shelling out to a second toolchain
that would then have to exist inside the deploy container as well.

The TypeScript generator stays exactly where it is. It serves the browser's download-a-zip feature,
which is unauthenticated, deploys nothing, and supports Terraform as well. Deleting it to avoid
having two generators would remove a working feature to satisfy a tidiness argument, and the two
have genuinely different jobs: one produces something a human reads, the other produces something a
machine runs in an account that can be charged.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`,
`docs/issues/epic-2-ir/040-resource-contract-registry.md`

### Contract

```python
# services/brain/src/brain/codegen/types.py
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import ClassVar, Protocol


@dataclass(frozen=True, slots=True)
class ResourceNode:
    """One entry from the IR's `resources` array, already schema-validated."""

    logical_id: str
    resource_type: str  # e.g. "aws.lambda.function"
    contract_version: int
    properties: Mapping[str, object]
    depends_on: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class EmitContext:
    experiment_id: str
    region: str
    ir_version: str
    generator_version: str
    resources: Mapping[str, ResourceNode]  # by logical_id, for reference resolution


@dataclass(frozen=True, slots=True)
class EmittedResource:
    python_name: str
    imports: tuple[str, ...]
    statements: tuple[str, ...]
    exports: tuple[tuple[str, str], ...]  # (export name, expression)


@dataclass(frozen=True, slots=True)
class GeneratedFile:
    path: str
    content: str


class Emitter(Protocol):
    resource_type: ClassVar[str]
    contract_version: ClassVar[int]

    def emit(self, node: ResourceNode, ctx: EmitContext) -> EmittedResource: ...


class UnsupportedResourceError(Exception):
    """Raised for a resource type with no registered emitter."""


class ContractVersionError(Exception):
    """Raised when the IR declares a contract version the emitter was not written against."""
```

```python
# services/brain/src/brain/codegen/registry.py
def register(emitter: Emitter) -> None: ...
def emitter_for(resource_type: str) -> Emitter: ...          # raises UnsupportedResourceError
def supported_types() -> tuple[str, ...]: ...                # sorted

# services/brain/src/brain/codegen/naming.py
def python_name(logical_id: str) -> str: ...                 # "OrdersApi" -> "orders_api"
def physical_suffix(experiment_id: str, logical_id: str) -> str: ...  # 8 hex chars, deterministic

# services/brain/src/brain/codegen/emit.py
def emit_program(ir: Mapping[str, object], ctx: EmitContext) -> GeneratedFile: ...
```

`emit_program` returns the single file `resources.py`: a module-level docstring naming
`ir_version` and `generator_version`, the sorted union of every emitter's imports, a `tags` dict
containing `infracanvas:experiment-id`, `infracanvas:managed-by` and the caller's region, then each
resource's statements in dependency order, then `pulumi.export` calls. It does not write
`Pulumi.yaml`, `buildspec.yml`, or `__main__.py`; those belong to
`docs/issues/epic-8-codegen/020-project-scaffold-and-s3-state.md`.

Emitters land for five resource types, which are the ones the load-testing epic needs to measure a
request path end to end:

| `resource_type`        | Module                         | Emits                                             |
| ---------------------- | ------------------------------ | ------------------------------------------------- |
| `aws.lambda.function`  | `emitters/lambda_function.py`  | `Role`, `RolePolicyAttachment`, `Function`        |
| `aws.s3.bucket`        | `emitters/s3_bucket.py`        | `BucketV2`, `BucketPublicAccessBlock`, versioning |
| `aws.dynamodb.table`   | `emitters/dynamodb_table.py`   | `Table` with on-demand billing                    |
| `aws.sqs.queue`        | `emitters/sqs_queue.py`        | `Queue` with SSE and a dead-letter queue          |
| `aws.apigatewayv2.api` | `emitters/apigatewayv2_api.py` | `Api`, `Stage`, `Integration`, `Permission`       |

Every emitter reads its defaults from the Resource Contract document for its type rather than
inlining them, applies `tags` to every taggable resource, and sets `force_destroy=True` on S3
buckets so `docs/issues/epic-9-deploy/040-one-click-destroy.md` can remove a non-empty bucket.

### Files

- CREATE `services/brain/src/brain/codegen/__init__.py`
- CREATE `services/brain/src/brain/codegen/types.py`
- CREATE `services/brain/src/brain/codegen/registry.py`
- CREATE `services/brain/src/brain/codegen/naming.py`
- CREATE `services/brain/src/brain/codegen/emit.py`
- CREATE `services/brain/src/brain/codegen/emitters/__init__.py`
- CREATE `services/brain/src/brain/codegen/emitters/lambda_function.py`
- CREATE `services/brain/src/brain/codegen/emitters/s3_bucket.py`
- CREATE `services/brain/src/brain/codegen/emitters/dynamodb_table.py`
- CREATE `services/brain/src/brain/codegen/emitters/sqs_queue.py`
- CREATE `services/brain/src/brain/codegen/emitters/apigatewayv2_api.py`
- CREATE `services/brain/tests/codegen/__init__.py`
- CREATE `services/brain/tests/codegen/test_registry.py`
- CREATE `services/brain/tests/codegen/test_naming.py`
- CREATE `services/brain/tests/codegen/test_emit.py`
- CREATE `services/brain/tests/codegen/test_emitters.py`

### Acceptance Criteria

- [ ] An IR containing a resource type with no registered emitter raises `UnsupportedResourceError`
      naming that type, rather than emitting a `# TODO` comment as the TypeScript generator does
- [ ] An IR declaring a contract version higher than the emitter's raises `ContractVersionError`
- [ ] Resources are emitted in dependency order, so no statement references a name defined later
- [ ] A dependency cycle in `depends_on` is reported as an error naming both logical ids
- [ ] Two resources whose logical ids normalise to the same Python name are rejected at emit time
- [ ] Every taggable resource carries `infracanvas:experiment-id` set to the context's experiment id
- [ ] Every S3 bucket is emitted with all four public-access-block flags true and `force_destroy=True`
- [ ] An unknown property in a resource's `properties` is an error, not silently dropped
- [ ] `emit_program` writes no timestamp, hostname, or random value into its output
- [ ] The emitted module parses under `ast.parse` for every fixture in the test suite

### Required Tests

- `raises unsupported resource error naming the missing type`
- `raises contract version error when the ir is newer than the emitter`
- `emits resources in dependency order`
- `rejects a dependency cycle naming both resources`
- `rejects two logical ids that collide as python names`
- `rejects an unrecognised property rather than dropping it`
- `tags every taggable resource with the experiment id`
- `emits a bucket with public access blocked and force destroy set`
- `emitted module parses as valid python`
- `emits nothing resembling a timestamp or a random suffix`

### Performance Budget

`emit_program` on a 200-resource IR completes in under 300ms, measured with
`pytest --durations=10` on the CI runner. Peak RSS for the emit path stays under 64MB, because this
runs inside the brain process alongside retrieval.

### Out of Scope

- Do not modify or delete `packages/core/src/codegen/pulumi.ts`, `terraform.ts`, or `zip.ts`; the
  browser export path keeps working unchanged
- Do not write `Pulumi.yaml`, `requirements.txt`, `buildspec.yml`, or `__main__.py` here
- Do not run ruff, mypy, or checkov over the output; that is the validation issue's contract
- Do not add emitters for EC2, RDS, CloudFront, or Cognito; each needs a Resource Contract entry
  first and would push this issue past one session
- Do not call the AWS API at emit time, including AMI lookups; the emitted program resolves those
  itself at deploy time

### Dependencies

Blocked by #3, and by the resource type vocabulary and per-type defaults in
`docs/issues/epic-2-ir/040-resource-contract-registry.md`.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/codegen -v
uv run --directory services/brain pytest --durations=10
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
