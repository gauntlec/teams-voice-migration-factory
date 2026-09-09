-- Feature request board. Staff (SUPER_ADMIN / PROJECT_MANAGER / ENGINEER)
-- submit enhancement ideas; a SUPER_ADMIN moves a card to 'in_development' as
-- the cue for Claude Code to implement it, and Claude sets 'deployed' on ship.
-- Platform-level (not tenant-scoped).

CREATE TABLE platform.feature_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  area              text NOT NULL,
  status            text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','under_review','scheduled','in_development','deployed','declined')),
  priority          text NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low','medium','high','urgent')),
  problem           text NOT NULL,
  proposal          text NOT NULL,
  current_behavior  text,
  examples          text,
  acceptance        text,
  constraints       text,
  affected_roles    text[] NOT NULL DEFAULT '{}',
  decision_note     text,
  submitted_by      uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  status_changed_by uuid REFERENCES platform.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_feature_requests_status ON platform.feature_requests(status);
CREATE INDEX idx_feature_requests_created_at ON platform.feature_requests(created_at DESC);
