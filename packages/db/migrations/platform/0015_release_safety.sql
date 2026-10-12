-- Safe releases and safe testing (docs/ARCHITECTURE.md "Operations").

-- One maintenance notice at a time (the single row has id = true). A
-- SUPER_ADMIN sets it before a release; staff see a banner, and new live
-- deployments / discovery runs / sign-ins are refused in its final minutes.
CREATE TABLE IF NOT EXISTS platform.maintenance_notice (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  message text NOT NULL,
  starts_at timestamptz NOT NULL,
  created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Test customers: every email for the customer goes to whoever triggered it
-- (else sandbox_email, else it is skipped), subject-prefixed with the real
-- recipient. Applied by the worker's mail sender, so it covers every template.
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false;
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS sandbox_email text;

-- Who a redirected test-customer email was really for (to_email is where it went).
ALTER TABLE platform.email_messages ADD COLUMN IF NOT EXISTS original_to_email text;
