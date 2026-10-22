-- Why a group-lookup (Microsoft Graph) sign-in failed, in words the engineer can act on ("the session was busy", "the code expired"),
-- shown next to Retry. Cleared whenever a new sign-in starts.
ALTER TABLE {{SCHEMA}}.connections ADD COLUMN graph_error text;
