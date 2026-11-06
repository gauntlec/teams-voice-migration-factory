-- What a user's calls do when unanswered, as chosen in Site Data (docs/DEPLOYMENT.md, Voicemail and unanswered calls). Same shape as
-- build_users.call_forwarding, which Populate copies it to. NULL: the default (voicemail after 20 seconds when voicemail is on).
ALTER TABLE {{SCHEMA}}.discovery_users ADD COLUMN IF NOT EXISTS call_forwarding jsonb;
