-- A fourth built-in assistant: Voxshift Changes, which carries change and removal service requests through
-- (docs/SERVICE-REQUEST-AGENTS.md).
ALTER TABLE platform.agents DROP CONSTRAINT IF EXISTS agents_builtin_key_check;
ALTER TABLE platform.agents ADD CONSTRAINT agents_builtin_key_check CHECK (builtin_key IN ('triage', 'diagnose', 'comms', 'changes'));
