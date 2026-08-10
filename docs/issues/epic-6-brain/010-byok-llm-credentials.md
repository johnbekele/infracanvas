---
title: '[api] Bring-your-own-key credentials and reasoning settings'
labels: tier:1, size:m, area:api, area:web, epic:6-brain
---

### Epic

#7

### Context

There is nowhere in the product to say which model to use or to supply a key for it. The Settings
item in the user menu renders and does nothing, there is no settings route, and no table stores a
user preference of any kind. The only credential the system holds is a GitHub token.

That blocks the whole model-assisted half of the product. Architecture refinement, the
Well-Architected critique, and the explanation of a proposal all need a provider, a model, and a
budget, and none of them can be built against a configuration surface that does not exist. It also
decides the deployment story: a self-hosted instance should run against the operator's own key or a
local Ollama, and a hosted instance should never hold a key it is not asked to hold.

Reasoning scale belongs here for the same reason. The difference between a cheap draft proposal and
a slow careful one is a per-request parameter, spelled differently by every provider, and the person
who pays for the tokens is the one who should choose it.

Keys are encrypted with the AES-256-GCM helper already used for GitHub tokens, and never leave the
server. The interface shows a masked hint so a user can tell which key is stored without the value
being retrievable from the browser.

### Contract

```sql
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  default_region text NOT NULL DEFAULT 'us-east-1',
  currency text NOT NULL DEFAULT 'USD',
  reasoning_scale text NOT NULL DEFAULT 'balanced'
    CHECK (reasoning_scale IN ('fast', 'balanced', 'thorough')),
  monthly_token_budget integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('openai', 'anthropic', 'bedrock', 'google', 'ollama')),
  model text NOT NULL,
  -- Null for providers that authenticate another way, such as bedrock via an
  -- instance role or a local ollama.
  api_key_encrypted text,
  -- Last four characters, so a user can identify the key without reading it.
  key_hint text,
  base_url text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, model)
);
CREATE UNIQUE INDEX llm_credentials_one_default_idx
  ON llm_credentials (user_id) WHERE is_default;
```

```
GET    /settings                     -> { settings, credentials }  // keys masked
PATCH  /settings          {...}      -> { settings }
POST   /settings/llm      {provider, model, apiKey?, baseUrl?} -> { credential }  201
DELETE /settings/llm/:id             -> 204
POST   /settings/llm/:id/default     -> { credential }
POST   /settings/llm/:id/verify      -> { ok, model?, error? }
```

```typescript
// packages/core/src/llm/reasoning.ts -- one scale, mapped per provider
export type ReasoningScale = 'fast' | 'balanced' | 'thorough';
export function reasoningParams(
  provider: LlmProvider,
  scale: ReasoningScale
): Record<string, string | number>;
```

### Files

- CREATE `db/migrations/*_user_settings.sql`
- CREATE `apps/api/src/lib/db/settings.ts`, `apps/api/src/lib/db/llm-credentials.ts`
- CREATE `apps/api/src/routes/settings/index.ts`, `apps/api/src/routes/settings/llm.ts`
- CREATE `apps/api/src/lib/llm/verify.ts` -- a minimal call that proves a key works
- CREATE `packages/core/src/llm/reasoning.ts`, `packages/core/src/llm/providers.ts`
- CREATE `apps/web/src/pages/SettingsPage.tsx`
- CREATE `apps/web/src/components/settings/` -- provider form, credential list, reasoning control
- CREATE `apps/web/src/lib/api/settings.ts`, `apps/web/src/lib/hooks/use-settings.ts`
- MODIFY `apps/web/src/components/auth/UserMenu.tsx` -- link the Settings item
- MODIFY `apps/web/src/App.tsx` -- `/settings` route

### Acceptance Criteria

- [ ] A stored API key is never returned by any endpoint; only its last four characters are
- [ ] A key is encrypted at rest and is unreadable in the table without the encryption key
- [ ] Marking a credential default clears the previous default in the same transaction
- [ ] A credential belonging to another user reads as "not found", not as a permission error
- [ ] Bedrock and Ollama may be configured with no API key
- [ ] OpenAI and Anthropic are refused without an API key
- [ ] Verifying a credential reports the failure reason without echoing the key
- [ ] The reasoning scale maps to a different parameter for each provider
- [ ] Settings load and save for a user who has never opened the page, with defaults applied
- [ ] The Settings menu item navigates to the settings page

### Required Tests

- `never returns a stored api key`
- `stores only the last four characters as a hint`
- `decrypts a stored key for server-side use`
- `clears the previous default when a new one is set`
- `does not return a credential belonging to another user`
- `accepts bedrock without an api key`
- `rejects openai without an api key`
- `reports a verification failure without including the key in the message`
- `maps the reasoning scale to provider-specific parameters`
- `returns defaults for a user with no settings row`

### Performance Budget

The settings page adds no weight to the initial JavaScript payload; it is loaded on demand like the
designer. Credential verification is bounded by a 10 s timeout so a wrong base URL cannot hold a
request open.

### Out of Scope

- Calling a model for anything; this issue only configures providers
- Per-repository or per-experiment overrides of the default model
- Token accounting and spend enforcement against the budget
- AWS credentials for deployment, which are a separate connection with different scopes

### Dependencies

Blocked by #22.

### Verification

```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
```

### Risk Tier

tier:1 - stores user credentials

### Size

size:m - 200 to 600 lines
