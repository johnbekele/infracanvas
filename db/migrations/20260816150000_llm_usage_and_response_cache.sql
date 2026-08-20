-- migrate:up

-- Every model call that can spend a user's key records a row here first.
-- The reservation INSERT checks the month-to-date total and writes in one
-- statement so two concurrent requests cannot both observe the same
-- under-budget sum and both proceed.
CREATE TABLE llm_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  reasoning     text NOT NULL,
  -- 'profile', 'profile-repair', 'judge'. Lets a user see which part of the
  -- product spent the budget rather than only that it is gone.
  purpose       text NOT NULL,
  estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
  input_tokens  integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_hit     boolean NOT NULL DEFAULT false,
  -- Generated rather than trigger-maintained so it can never disagree with
  -- created_at, and so the monthly sum can use one index.
  billing_month date NOT NULL GENERATED ALWAYS AS
    ((date_trunc('month', created_at AT TIME ZONE 'UTC'))::date) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_usage_user_month_idx ON llm_usage (user_id, billing_month);

CREATE TRIGGER llm_usage_set_updated_at
  BEFORE UPDATE ON llm_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Content-hash cache keyed per user. Cross-user deduplication is rejected on
-- purpose: an identical prompt hash for this product means identical private
-- source in the prompt.
CREATE TABLE llm_response_cache (
  cache_key     text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  reasoning     text NOT NULL,
  response      jsonb NOT NULL,
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  hit_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_hit_at   timestamptz
);

CREATE INDEX llm_response_cache_created_idx ON llm_response_cache (created_at);

-- migrate:down

DROP TABLE IF EXISTS llm_response_cache;
DROP TABLE IF EXISTS llm_usage;
