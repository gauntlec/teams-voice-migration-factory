-- Handset tracker: a "delivered" stage between ordered and added-to-tooling (the handsets have arrived).
ALTER TABLE {{SCHEMA}}.site_handset_tracking DROP CONSTRAINT IF EXISTS site_handset_tracking_status_check;
ALTER TABLE {{SCHEMA}}.site_handset_tracking
  ADD CONSTRAINT site_handset_tracking_status_check CHECK (status IN ('ordered','delivered','in_tooling','installed'));
