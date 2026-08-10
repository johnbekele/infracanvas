-- migrate:up

-- What a user has chosen, as distinct from what they are.
--
-- A row is created on first write rather than at sign-up, so the defaults here
-- are the real defaults: a user who has never opened the settings page and one
-- who opened it and changed nothing behave identically.
CREATE TABLE user_settings (
  user_id              uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  default_region       text        NOT NULL DEFAULT 'us-east-1',
  currency             text        NOT NULL DEFAULT 'USD',
  -- How hard the model should think. One scale here, mapped to whatever each
  -- provider calls it, because the person paying for the tokens is the one who
  -- should decide and they should not have to learn five spellings of it.
  reasoning_scale      text        NOT NULL DEFAULT 'balanced'
    CHECK (reasoning_scale IN ('fast', 'balanced', 'thorough')),
  monthly_token_budget integer     CHECK (monthly_token_budget IS NULL OR monthly_token_budget > 0),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER user_settings_set_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A model the user has told us to use, and the key to reach it with.
--
-- Bring-your-own-key rather than a shared account: a self-hosted instance runs
-- against the operator's own key or a local Ollama, and a hosted instance never
-- holds a key it was not asked to hold.
CREATE TABLE llm_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          text        NOT NULL
    CHECK (provider IN ('openai', 'anthropic', 'bedrock', 'google', 'ollama')),
  model             text        NOT NULL,
  -- Null for providers that authenticate another way: Bedrock through an
  -- instance role, Ollama because it is on localhost.
  api_key_encrypted text,
  -- Last four characters, so a user can tell which key is stored without the
  -- value ever being retrievable from the browser.
  key_hint          text,
  base_url          text,
  is_default        boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, model)
);

-- One default per user, stated as a constraint rather than maintained by
-- application code that could be interrupted between the clear and the set.
CREATE UNIQUE INDEX llm_credentials_one_default_idx
  ON llm_credentials (user_id) WHERE is_default;

-- migrate:down

DROP TABLE IF EXISTS llm_credentials;
DROP TABLE IF EXISTS user_settings;
