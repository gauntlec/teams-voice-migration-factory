-- The assistants Voxshift ships (Triage, Diagnose, Comms: docs/BUILTIN-AGENTS.md) are ordinary agents with
-- one extra fact: which built-in they are. The API runs them itself, so they have no tokens and no webhooks.
ALTER TABLE platform.agents ADD COLUMN builtin_key text CHECK (builtin_key IN ('triage', 'diagnose', 'comms'));
CREATE UNIQUE INDEX agents_builtin_key_uq ON platform.agents (builtin_key) WHERE builtin_key IS NOT NULL;
