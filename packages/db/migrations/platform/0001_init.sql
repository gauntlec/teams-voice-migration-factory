-- Platform (control-plane) schema. Cross-tenant tables only.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE platform.tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  schema_name    text NOT NULL UNIQUE,
  primary_domain text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('SUPER_ADMIN','ENGINEER','CUSTOMER')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  totp_enrolled boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.tenant_memberships (
  user_id    uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  added_by   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX idx_memberships_tenant ON platform.tenant_memberships(tenant_id);

CREATE TABLE platform.totp_secrets (
  user_id      uuid PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
  secret_enc   text NOT NULL,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL,
  family_id    uuid NOT NULL,
  user_agent   text,
  ip           text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON platform.auth_sessions(user_id);
CREATE INDEX idx_sessions_family ON platform.auth_sessions(family_id);

CREATE TABLE platform.invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('SUPER_ADMIN','ENGINEER','CUSTOMER')),
  tenant_id   uuid REFERENCES platform.tenants(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  invited_by  uuid NOT NULL REFERENCES platform.users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.platform_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_email   text,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  tenant_id     uuid,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text
);
CREATE INDEX idx_platform_audit_at ON platform.platform_audit_log(at DESC);
CREATE INDEX idx_platform_audit_tenant ON platform.platform_audit_log(tenant_id);
