-- Service Handover reminders (docs/HANDOVER-VIEW.md step 4): an outstanding action still open this many days after it was added is
-- overdue. The site's Provider PM(s) and whoever generated its pack are emailed, and the menu shows the count. 0 = no reminders.
ALTER TABLE platform.tenants
  ADD COLUMN handover_reminder_days integer NOT NULL DEFAULT 7 CHECK (handover_reminder_days BETWEEN 0 AND 365);
