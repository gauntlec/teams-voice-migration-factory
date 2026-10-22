-- The engineer's answer when a user's or common area phone's designed number differs from the number live in the tenant
-- (or from the one Data Collection assigned after the site was submitted): accepted or rejected, with the numbers it was
-- decided against. If any of those numbers change later the decision no longer applies and the change is flagged again.
-- Shape: { "decision": "accepted" | "rejected", "designed": "+1...", "live": "+1..." | null, "dataCollection": "+1..." | null,
--          "by": "<user id>", "byName": "...", "at": "<iso timestamp>" }
ALTER TABLE {{SCHEMA}}.build_users ADD COLUMN number_decision jsonb;
ALTER TABLE {{SCHEMA}}.build_caps  ADD COLUMN number_decision jsonb;
