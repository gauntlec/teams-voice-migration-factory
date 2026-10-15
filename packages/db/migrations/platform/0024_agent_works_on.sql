-- Where an assistant works: incidents, service requests, or both (docs/AGENTS.md, "Where an assistant works").
-- Existing assistants keep working on both so nothing stops; the built-in ones are narrowed to what they do.
ALTER TABLE platform.agents
  ADD COLUMN works_on text[] NOT NULL DEFAULT ARRAY['incidents', 'service_requests']::text[],
  ADD CONSTRAINT agents_works_on_check CHECK (works_on <@ ARRAY['incidents', 'service_requests']::text[] AND cardinality(works_on) > 0);

UPDATE platform.agents SET works_on = ARRAY['service_requests']::text[] WHERE builtin_key = 'changes';
UPDATE platform.agents SET works_on = ARRAY['incidents']::text[] WHERE builtin_key IN ('triage', 'diagnose', 'comms');
