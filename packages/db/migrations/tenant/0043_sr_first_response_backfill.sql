-- first_response_at (0039) only started being recorded then. Requests the team
-- had already moved on before it existed get their first move as the first
-- response, so they aren't shown (or emailed) as waiting for a reply.
UPDATE {{SCHEMA}}.service_requests
SET first_response_at = coalesce(planned_at, built_at, deployed_at, declined_at, cancelled_at)
WHERE first_response_at IS NULL AND status <> 'new';
