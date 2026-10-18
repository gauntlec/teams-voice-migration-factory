-- Single sign-on (OpenID Connect), the installation's side: docs/SSO.md sections 4.1-4.6 and 4.8.

-- Identity providers this installation can sign people in with: the Voxshift Hub (kind 'hub', at most one, created by the hub connection)
-- and the customer's own OpenID Connect providers (kind 'oidc': Entra ID, Okta, Google Workspace, Keycloak...).
CREATE TABLE platform.sso_providers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CHECK (kind IN ('hub', 'oidc')),
  name                   text NOT NULL,
  issuer                 text NOT NULL,
  client_id              text NOT NULL,
  -- AES-256-GCM with DATA_ENCRYPTION_KEY, like the SMTP password. Never returned by the API.
  client_secret_enc      text,
  scopes                 text NOT NULL DEFAULT 'openid email profile',
  -- Off until an administrator of this installation switches it on (the hub provider is created off).
  enabled                boolean NOT NULL DEFAULT false,
  jit_create             boolean NOT NULL DEFAULT true,
  require_mfa_claim      boolean NOT NULL DEFAULT true,
  -- The most a person from this provider can be: the lower of what the provider asks for and this (docs/SSO.md 4.3).
  -- 'oidc' providers use role_ceiling; the hub uses one ceiling for Voxshift/MSP staff and one for the customer's own people.
  role_ceiling           text NOT NULL DEFAULT 'PROJECT_MANAGER' CHECK (role_ceiling IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER')),
  role_ceiling_staff     text NOT NULL DEFAULT 'SUPER_ADMIN' CHECK (role_ceiling_staff IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER')),
  role_ceiling_customer  text NOT NULL DEFAULT 'ENGINEER' CHECK (role_ceiling_customer IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER')),
  -- What a person gets when the provider says nothing about a role (least privilege by default).
  default_role           text NOT NULL DEFAULT 'CUSTOMER' CHECK (default_role IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER')),
  -- 'oidc' only: the claim that carries the role (for example "roles" or "groups") and what each value means.
  role_claim             text,
  role_map               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional allow-list of email domains; empty = any.
  email_domains          text[] NOT NULL DEFAULT '{}',
  -- false = the local sign-in form is hidden for everyone except break-glass accounts (users.break_glass).
  allow_local_passwords  boolean NOT NULL DEFAULT true,
  -- The result of the last "Test sign-in" (shown on the settings screen).
  last_test_at           timestamptz,
  last_test_ok           boolean,
  last_test_detail       text,
  created_by             uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- One hub provider per installation.
CREATE UNIQUE INDEX sso_providers_one_hub ON platform.sso_providers ((true)) WHERE kind = 'hub';
CREATE UNIQUE INDEX sso_providers_name_uq ON platform.sso_providers (lower(name));

-- Who a local user is at a provider. There is NO matching by email: a row exists only because the person signed in for the first time
-- with just-in-time creation, or because an administrator linked it on purpose.
CREATE TABLE platform.external_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES platform.sso_providers(id) ON DELETE CASCADE,
  subject       text NOT NULL,
  email         text,
  -- The hub's kind of account ('staff' or 'customer') at the last sign-in, so a lowered ceiling can be applied at the next token refresh.
  account_kind  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider_id, subject)
);
CREATE INDEX external_identities_user ON platform.external_identities (user_id);

-- Sign-ins that were refused because a local account with the same email already exists. The Users screen offers them to an administrator
-- ("Link to provider identity") so nobody has to find a provider's subject id by hand. Nothing here lets anyone in by itself.
CREATE TABLE platform.sso_link_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    uuid NOT NULL REFERENCES platform.sso_providers(id) ON DELETE CASCADE,
  subject        text NOT NULL,
  email          text NOT NULL,
  display_name   text,
  account_kind   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, subject)
);

-- Single use of authorization codes and ID tokens (docs/SSO.md 4.2): a code or jti seen once is refused afterwards. Rows are only needed
-- until the token would have expired anyway.
CREATE TABLE platform.sso_replay_guard (
  key         text PRIMARY KEY,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sso_replay_guard_expires ON platform.sso_replay_guard (expires_at);

-- Break glass (docs/SSO.md 4.6): locally created Super Admins keep password + authenticator sign-in even when local passwords are switched off.
ALTER TABLE platform.users ADD COLUMN break_glass boolean NOT NULL DEFAULT false;
UPDATE platform.users SET break_glass = true WHERE role = 'SUPER_ADMIN';

-- How a session was started (docs/SSO.md 4.5): the authentication methods the provider reported (amr), which provider (null = local
-- password), and the absolute end of a federated session whatever refreshing does.
ALTER TABLE platform.auth_sessions
  ADD COLUMN amr text[] NOT NULL DEFAULT '{}',
  ADD COLUMN idp uuid REFERENCES platform.sso_providers(id) ON DELETE CASCADE,
  ADD COLUMN absolute_expires_at timestamptz;

-- Platform settings: how long a federated session lasts before the person signs in at the provider again, and whether administrators
-- are emailed when someone signs in as Super Admin through a provider.
ALTER TABLE platform.app_settings
  ADD COLUMN sso_session_max_hours integer NOT NULL DEFAULT 12 CHECK (sso_session_max_hours BETWEEN 1 AND 720),
  ADD COLUMN sso_notify_admin_signin boolean NOT NULL DEFAULT true;
