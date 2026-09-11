-- build_users/build_caps/build_resource_accounts need a real link to the
-- tenant_policies row a picked policy came from - not just a copied name
-- string. Mirrors 0017_build_phone_number_id.sql exactly, for the same
-- reason: a Discovery re-run upserts tenant_policies on object_id (stable
-- id across a rename), but policies.<key> only ever stored the name, so a
-- rename in the tenant silently broke validation's name match and would
-- deploy the stale old name via Grant-Cs*Policy. policy_ids is the durable
-- reference; policies.<key> stays the last-resolved display/deploy name,
-- kept in sync by the API whenever policy_ids.<key> is set (see
-- BuildService.resolvePolicyIds) and re-resolved to the live name again at
-- deploy time (see worker main.ts handleDeploymentRun).

ALTER TABLE {{SCHEMA}}.build_users
  ADD COLUMN policy_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{SCHEMA}}.build_caps
  ADD COLUMN policy_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD COLUMN voice_routing_policy_id uuid REFERENCES {{SCHEMA}}.tenant_policies(id) ON DELETE SET NULL;

-- Best-effort backfill: for every POLICY_KINDS entry with a known
-- TenantPolicyType (POLICY_KIND_TO_TENANT_TYPE in packages/shared/src/domain.ts
-- - dial_out_policy has none and stays unlinked, a documented gap), resolve
-- the row's current policies.<key> name against the live tenant_policies row
-- of that type and record its id. Policy names/identities are unique per
-- type within a tenant, so a plain name match is unambiguous.

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{voice_routing_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'OnlineVoiceRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'voice_routing_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{voice_routing_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'OnlineVoiceRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'voice_routing_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{shared_calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsSharedCallingRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'shared_calling_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{shared_calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsSharedCallingRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'shared_calling_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{dial_plan}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TenantDialPlan' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'dial_plan';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{dial_plan}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TenantDialPlan' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'dial_plan';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'calling_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'calling_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{call_hold_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallHoldPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'call_hold_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{call_hold_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallHoldPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'call_hold_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{call_park_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallParkPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'call_park_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{call_park_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsCallParkPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'call_park_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{caller_id_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'CallingLineIdentity' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'caller_id_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{caller_id_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'CallingLineIdentity' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'caller_id_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{voice_app_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsVoiceApplicationsPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'voice_app_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{voice_app_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsVoiceApplicationsPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'voice_app_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{voicemail_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'OnlineVoicemailPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'voicemail_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{voicemail_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'OnlineVoicemailPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'voicemail_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{emergency_calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsEmergencyCallingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'emergency_calling_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{emergency_calling_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsEmergencyCallingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'emergency_calling_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{emergency_call_routing_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsEmergencyCallRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'emergency_call_routing_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{emergency_call_routing_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsEmergencyCallRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'emergency_call_routing_policy';

UPDATE {{SCHEMA}}.build_users bu
  SET policy_ids = jsonb_set(bu.policy_ids, '{ip_phone_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsIPPhonePolicy' AND tp.removed_at IS NULL
    AND tp.name = bu.policies->>'ip_phone_policy';
UPDATE {{SCHEMA}}.build_caps bc
  SET policy_ids = jsonb_set(bc.policy_ids, '{ip_phone_policy}', to_jsonb(tp.id::text))
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'TeamsIPPhonePolicy' AND tp.removed_at IS NULL
    AND tp.name = bc.policies->>'ip_phone_policy';

UPDATE {{SCHEMA}}.build_resource_accounts bra
  SET voice_routing_policy_id = tp.id
  FROM {{SCHEMA}}.tenant_policies tp
  WHERE tp.policy_type = 'OnlineVoiceRoutingPolicy' AND tp.removed_at IS NULL
    AND tp.name = bra.voice_routing_policy
    AND bra.voice_routing_policy_id IS NULL;
