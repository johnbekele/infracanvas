---
title: '[brain] Provider registry over pydantic-ai models'
labels: tier:1, size:m, area:brain, epic:6-brain
---

### Epic

#7

### Context

#61 gave a user somewhere to put a model provider, a model name, an encrypted key and a base URL,
and a way to mark one of them default. Nothing reads any of it. Every remaining issue in this epic
needs a model handle, and if each one constructs its own the provider choice ends up hard-coded in
five places and the promise that switching provider is configuration rather than a code change dies
quietly.

**pydantic-ai rather than the vendor SDKs or a LiteLLM proxy.** Calling five SDKs directly means
five client shapes, five ways of asking for structured output, and five places to fix when one of
them changes. LiteLLM solves that but is a second process to run and a second place decrypted keys
live, which is a poor trade for a product whose selling point is that it runs on a laptop.
pydantic-ai gives one `Model` abstraction and typed structured output, which
`040-appprofile-agent-with-citations.md` is built on, and its provider classes already cover every
target here.

**Ollama is not an afterthought.** A contributor with no API key, and CI with no secrets, must be
able to run every test in this epic. That only works if "no key" is a valid state for exactly one
provider rather than an error path bolted on later, so the registry treats a missing key as fatal
for the hosted providers and expected for Ollama, whose base URL defaults to
`http://localhost:11434/v1`. Bedrock is the other exception: it authenticates with the ambient AWS
credential chain and stores no key at all, so a Bedrock row with an empty `encrypted_api_key` is
valid rather than corrupt.

**Decryption happens here rather than over HTTP.** `apps/api/src/lib/encryption.ts` writes
AES-256-GCM as `iv:authTag:ciphertext`, all hex, under `ENCRYPTION_KEY`. The alternative considered
was having the brain ask the API for a plaintext key, which puts a decrypted credential on a network
hop for no benefit. Python reads the same envelope with the same key instead; the format is fixed by
data that already exists, so this issue matches it rather than choosing it.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/llm/providers.py
from typing import Literal

ProviderId = Literal[
    "anthropic",
    "bedrock",
    "openai",
    "gemini",
    "ollama",
    "openai-compatible",
]


@dataclass(frozen=True, slots=True)
class ProviderCredential:
    provider: ProviderId
    model: str
    # None for ollama and bedrock; required for every other provider.
    api_key: str | None
    # Required for openai-compatible; optional elsewhere.
    base_url: str | None

    def __repr__(self) -> str:
        """Redacts the key. A credential ends up in tracebacks and log records,
        and neither is a place a user's API key may appear."""


class UnknownProviderError(ValueError):
    """The stored provider string is not one this build knows."""


class MissingCredentialError(RuntimeError):
    """The provider needs a field the stored row does not have."""


def build_model(credential: ProviderCredential, settings: Settings) -> Model:
    """Construct a pydantic-ai model. Opens no socket and makes no request."""
```

```python
# services/brain/src/brain/llm/crypto.py
def decrypt(payload: str, key: bytes) -> str | None:
    """Read `iv:authTag:ciphertext`, all hex, AES-256-GCM, as written by
    `apps/api/src/lib/encryption.ts`.

    Returns None when the payload is malformed, when the IV or tag is the wrong
    length, or when the tag does not authenticate. A caller cannot act on the
    difference between those cases and an exception per variant only invites a
    bare `except`.
    """
```

```python
# services/brain/src/brain/llm/credentials.py
async def load_default_credential(user_id: UUID, settings: Settings) -> ProviderCredential:
    """Read the row #61 marks default for this user and decrypt its key.

    Raises MissingCredentialError when there is no default row, and when the
    stored ciphertext does not decrypt under the current ENCRYPTION_KEY.
    """
```

The query, against the table #61 created. Follow the landed migration if a column name differs
rather than adding a translation layer:

```sql
SELECT provider, model, encrypted_api_key, base_url
FROM llm_credentials
WHERE user_id = %(user_id)s AND is_default
LIMIT 1;
```

Registry dispatch is a table, not a chain of `if`s, because the whole point is that adding the
seventh provider touches one line:

```python
_BUILDERS: dict[ProviderId, Callable[[ProviderCredential, Settings], Model]] = {
    "anthropic": _build_anthropic,
    "bedrock": _build_bedrock,
    "openai": _build_openai,
    "gemini": _build_gemini,
    "ollama": _build_ollama,
    "openai-compatible": _build_openai_compatible,
}
```

`Settings` gains two fields, keeping the existing rule that a missing value is not fatal at import:

```python
@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str | None
    environment: str
    # 64 hex characters, the same value apps/api reads as ENCRYPTION_KEY.
    encryption_key: str | None
    # Default "http://localhost:11434/v1"; the offline path depends on it.
    ollama_base_url: str
```

### Files

- CREATE `services/brain/src/brain/llm/__init__.py`
- CREATE `services/brain/src/brain/llm/providers.py`
- CREATE `services/brain/src/brain/llm/crypto.py`
- CREATE `services/brain/src/brain/llm/credentials.py`
- MODIFY `services/brain/src/brain/settings.py` - add `encryption_key` and `ollama_base_url`
- MODIFY `services/brain/pyproject.toml` - add `pydantic-ai-slim` with the provider extras and `cryptography`
- CREATE `services/brain/tests/test_crypto.py`
- CREATE `services/brain/tests/test_providers.py`
- CREATE `services/brain/tests/test_credentials.py`
- MODIFY `services/brain/README.md` - how to run the service against a local Ollama with no key

### Acceptance Criteria

- [ ] `build_model` returns a model for each of the six providers without opening a socket
- [ ] Ollama builds with no API key and no row in `llm_credentials`, using `OLLAMA_BASE_URL`
- [ ] Bedrock builds with no stored key and defers to the ambient AWS credential chain
- [ ] An unrecognised provider string raises `UnknownProviderError` naming the value, rather than falling back to a default
- [ ] `openai-compatible` with no `base_url` raises `MissingCredentialError` rather than defaulting to the OpenAI endpoint
- [ ] Anthropic, OpenAI and Gemini each raise `MissingCredentialError` when the decrypted key is absent
- [ ] `decrypt` returns None rather than raising when the authentication tag does not verify
- [ ] A ciphertext produced by `apps/api/src/lib/encryption.ts` decrypts to the same plaintext in Python
- [ ] The API key appears in no `repr`, no log record and no exception message, asserted against captured log output
- [ ] Changing which row is default changes the model that is built, with no code change and no restart

### Required Tests

- `test_builds_a_model_for_every_supported_provider`
- `test_ollama_builds_without_an_api_key`
- `test_bedrock_builds_without_a_stored_key`
- `test_unknown_provider_raises_rather_than_defaulting`
- `test_openai_compatible_without_a_base_url_is_rejected`
- `test_hosted_provider_without_a_key_is_rejected`
- `test_decrypt_returns_none_for_a_tampered_ciphertext`
- `test_decrypt_reads_a_payload_written_by_the_typescript_api`
- `test_credential_repr_and_logs_never_contain_the_key`

### Performance Budget

`build_model` completes in under 5ms and performs no I/O, asserted with `time.perf_counter` and a
socket guard in the test. `load_default_credential` issues exactly one query and returns in under
10ms against a warm pool, measured in the integration test.

### Out of Scope

- Do not map the reasoning scale onto provider parameters; `030-reasoning-scale-mapping.md` owns that
- Do not write any agent, prompt, tool or output schema
- Do not touch `apps/api/src/lib/encryption.ts` or change the stored ciphertext envelope
- Do not add HTTP routes or UI for managing credentials; #61 owns that surface
- Do not add a proxy process or a second credential store

### Dependencies

Blocked by #61 and #30.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain ruff format --check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
