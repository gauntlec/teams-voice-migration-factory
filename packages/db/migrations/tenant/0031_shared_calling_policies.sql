-- Shared Calling setup workflow (feature request "Shared Calling setup
-- workflow in Design & Build and Deployment"): Design & Build had no way to
-- manage TeamsSharedCallingRoutingPolicy objects themselves - only to grant
-- an existing one via build_users/build_caps.policies.shared_calling_policy
-- (that grant path, and planIdentityRow's EV-only Set-CsPhoneNumberAssignment
-- for these rows, already worked correctly before this migration).
--
-- New-/Set-CsTeamsSharedCallingRoutingPolicy (verified against Microsoft
-- Learn 2026-09-23): -Identity (the policy name), -ResourceAccount (an
-- existing resource account's Identity, used as outbound/callback caller
-- ID), -EmergencyNumbers (array of PSTN numbers reserved for emergency
-- callback), -Description (optional). No separate live inventory table -
-- Discovery already captures the full live object under
-- tenant_policies.data (policy_type = 'TeamsSharedCallingRoutingPolicy',
-- via the generic TENANT_POLICY_TYPES sweep), so the live-diff reads that
-- directly rather than adding a second capture path.

CREATE TABLE {{SCHEMA}}.build_shared_calling_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  name                text NOT NULL,
  resource_account_id uuid REFERENCES {{SCHEMA}}.build_resource_accounts(id) ON DELETE SET NULL,
  emergency_numbers   jsonb NOT NULL DEFAULT '[]'::jsonb,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_build_shared_calling_policies_site ON {{SCHEMA}}.build_shared_calling_policies(site_id);
