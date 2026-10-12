-- After a live (execute) deployment the worker re-reads the people and
-- resource accounts it changed and compares them to the design (see
-- apps/worker/src/deployment-verify.ts). The verdict is stored here: null
-- until a re-check has run (dry runs never get one), then a
-- DeploymentVerification object (packages/shared/src/deployment-verify.ts).
ALTER TABLE {{SCHEMA}}.deployments
  ADD COLUMN IF NOT EXISTS verification jsonb;
