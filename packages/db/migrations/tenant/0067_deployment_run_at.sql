-- Scheduled cutover: a live run that starts at a set time (inside the change window) on the engineer's live sign-in, which the
-- worker keeps alive until then. NULL = started at once. docs/DEPLOYMENT.md "Scheduled runs".
ALTER TABLE {{SCHEMA}}.deployments ADD COLUMN run_at timestamptz;
