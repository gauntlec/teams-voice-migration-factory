-- Agent events can now be about a service request as well as an incident.
ALTER TABLE platform.agent_events ADD COLUMN request_id uuid;
