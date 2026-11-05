-- Scheduled reports (docs/INSIGHTS.md, step 4b): a report emailed as a PDF, monthly (covering last month) or quarterly
-- (covering last quarter), to people who can open the customer. Each person's copy is built with what their own role and
-- sites allow. InsightsScheduleService sends the ones that are due.
CREATE TABLE {{SCHEMA}}.report_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_key   text NOT NULL,
  frequency    text NOT NULL CHECK (frequency IN ('monthly', 'quarterly')),
  recipients   jsonb NOT NULL DEFAULT '[]'::jsonb, -- platform user ids
  enabled      boolean NOT NULL DEFAULT true,
  next_run_at  timestamptz NOT NULL,
  last_run_at  timestamptz,
  last_status  text,                               -- 'sent' | 'partly_sent' | 'email_off' | 'failed'
  last_detail  text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_schedules_due ON {{SCHEMA}}.report_schedules(next_run_at) WHERE enabled;
