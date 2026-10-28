-- A port-in range moves from the carrier it is with now (carrier) to a new one (new_carrier). The carrier side of the port is tracked
-- here: the carrier's order reference, when it was submitted to the carrier, the scheduled port date (FOC), and when it completed.
-- Completing the port switches carrier to new_carrier and keeps the old one in previous_carrier. The document side stays in
-- number_port_requests.
ALTER TABLE {{SCHEMA}}.discovery_number_ranges
  ADD COLUMN new_carrier                  text,         -- the carrier the numbers are moving to (a 'port' range)
  ADD COLUMN previous_carrier             text,         -- the carrier before the port completed
  ADD COLUMN port_order_ref               text,         -- the new carrier's port order / reference number
  ADD COLUMN port_submitted_to_carrier_at timestamptz,
  ADD COLUMN port_foc_date                date,         -- scheduled port date (firm order commitment)
  ADD COLUMN port_completed_at            timestamptz,
  ADD COLUMN port_completed_by            uuid;
