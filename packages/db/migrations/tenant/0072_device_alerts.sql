-- Monitoring email alerts (docs/DEVICE-MONITORING.md): who is emailed when a device goes down or comes back, and how often.
-- One row per customer. cursor = the last device_status_changes id already looked at (news before it has been dealt with);
-- last_sent_at = when the last alert went out (the "at most every ..." rules count from it).
CREATE TABLE {{SCHEMA}}.device_alert_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled                 boolean NOT NULL DEFAULT false,
  frequency               text    NOT NULL DEFAULT 'immediate' CHECK (frequency IN ('immediate', '15m', '30m', '1h', '4h', 'daily')),
  reminder_hours          integer NOT NULL DEFAULT 0 CHECK (reminder_hours IN (0, 1, 4, 24)),
  notify_engineers        boolean NOT NULL DEFAULT true,
  notify_project_managers boolean NOT NULL DEFAULT false,
  recipients              jsonb   NOT NULL DEFAULT '[]',
  cursor                  bigint  NOT NULL DEFAULT 0,
  last_sent_at            timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO {{SCHEMA}}.device_alert_settings DEFAULT VALUES;

-- When an email last told people this device was down (a reminder counts from here). NULL = never.
ALTER TABLE {{SCHEMA}}.device_monitors ADD COLUMN last_alerted_at timestamptz;
