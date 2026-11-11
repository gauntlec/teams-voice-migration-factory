-- Call Flows (preview), docs/CALL-FLOWS-WIZARD.md: which wizard made a Call flow capture, so it reopens there.
-- 'call-flows' = Call Flows (preview); null = a classic wizard, or a row added by hand or from Discovery.
ALTER TABLE {{SCHEMA}}.discovery_flows
  ADD COLUMN editor text CHECK (editor IN ('call-flows'));
