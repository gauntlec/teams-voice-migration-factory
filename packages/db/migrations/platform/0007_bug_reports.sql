-- Bug report board. Staff (SUPER_ADMIN / PROJECT_MANAGER / ENGINEER) log
-- defects found in the platform itself; a SUPER_ADMIN/ENGINEER moves a card
-- through the lifecycle as it's triaged, fixed and shipped. Platform-level
-- (not tenant-scoped) - mirrors platform.feature_requests structurally.

CREATE TABLE platform.bug_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  area                text NOT NULL,
  status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','confirmed','in_progress','fixed','deployed','wont_fix','duplicate')),
  severity            text NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('low','medium','high','critical')),
  steps_to_reproduce  text NOT NULL,
  expected_behavior   text NOT NULL,
  actual_behavior     text NOT NULL,
  affected_customer   text,
  environment         text,
  resolution_note     text,
  reported_by         uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  status_changed_by   uuid REFERENCES platform.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_bug_reports_status ON platform.bug_reports(status);
CREATE INDEX idx_bug_reports_created_at ON platform.bug_reports(created_at DESC);
