BEGIN;
-- Never written by 0.1, and their ON DELETE CASCADE would erase history that
-- must outlive meetings and events (feedback learning, AI cost).
DROP TABLE IF EXISTS attention_event_feedback;
DROP TABLE IF EXISTS ai_usage;
CREATE TABLE feedback_signal(
  id text PRIMARY KEY,
  event_id text NOT NULL,
  event_type text NOT NULL,
  rating text NOT NULL CHECK(rating IN ('useful','unimportant','false-positive','dismissed','responded')),
  at timestamptz NOT NULL
);
CREATE INDEX feedback_signal_at ON feedback_signal(at);
CREATE TABLE ai_call(
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  provider text NOT NULL,
  model text,
  task text NOT NULL,
  tier text NOT NULL,
  meeting_id text NOT NULL,
  event_id text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer NOT NULL,
  estimated_cost numeric,
  ok boolean NOT NULL,
  error text
);
CREATE INDEX ai_call_at ON ai_call(at);
INSERT INTO schema_migration(version) VALUES(2);
COMMIT;
