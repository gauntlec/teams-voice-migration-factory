# Data model

Derived from the current artifacts:
- `ATTC MS Teams Build 5.3.xlsx` — sheets General, Checklist, DID Ranges,
  PORTING, USERS, CAPS, Analog GW & SIP Devices, M365 GROUPS, CALL QUEUES,
  HOLIDAYS, AUTO ATTENDANTS, Calling & Special Features, E911 LAN, Policies.
- `Teams-Migration-Build-*.ps1` — the cmdlets it runs (target state).
- `Service Hand-Over Pack V1.18.docx` — the output document sections.

## `platform` schema

| Table | Key columns |
|-------|-------------|
| `tenants` | id (uuid), slug, name, schema_name, status (`active`/`archived`), created_by, created_at |
| `users` | id, email (citext, unique), password_hash, display_name, role (`SUPER_ADMIN`/`PROJECT_MANAGER`/`ENGINEER`/`CUSTOMER`), status (`active`/`disabled`), totp_enrolled, **`must_change_password`** (true until the forced first-sign-in reset), **`password_changed_at`**, failed_logins, locked_until, created_at |
| `tenant_memberships` | user_id, tenant_id, added_by, **`site_ids uuid[]`** (empty = whole customer; else the `discovery_sites.id` values a CUSTOMER "site contact" is limited to — no cross-schema FK, validated by the API), created_at  (PK user_id+tenant_id) |
| `totp_secrets` | user_id (PK), secret_enc, confirmed_at |
| `auth_sessions` | id, user_id, refresh_hash, family_id, user_agent, ip, expires_at, revoked_at, replaced_by |
| `invitations` | id, email, role, tenant_id, token_hash, invited_by, expires_at, accepted_at |
| `email_messages` | id, to_email (citext), to_name, template, context (jsonb), subject, status (`queued`/`sent`/`failed`/`skipped`), error, attempts, related_type + related_id, created_by, created_at, sent_at — the comms log; API inserts + enqueues, worker sends. See [`EMAIL.md`](EMAIL.md) |
| `feature_requests` | id, title, area, status (`new`/`under_review`/`scheduled`/`in_development`/`deployed`/`declined`), priority (`low`/`medium`/`high`/`urgent`), problem, proposal, current_behavior, examples, acceptance, constraints, affected_roles (text[]), decision_note, submitted_by, created_at, updated_at, status_changed_at/by — the feature-request board. Staff submit; a SUPER_ADMIN moves a card to `in_development` (the cue for Claude Code) and to `deployed` on ship. Values in `packages/shared/src/domain.ts` |
| `platform_audit_log` | id, at, actor_user_id, actor_email, action, target_type, target_id, tenant_id, detail (jsonb), ip |

## tenant `tenant_<shortid>` schema

### Data Collection (discovery)
Aligned to `Overland Park - ATTC MS Teams Telephony Discovery Template`.
| Table | Notes |
|-------|-------|
| `discovery` | one row: id, status (`draft`/`submitted`/`accepted`), submitted_by/at, accepted_by/at, general jsonb (migration id, region, author, licensing model, contact, notes) |
| `discovery_sites` | **`sitecode`** (unique key), name, address, country, region, `latitude`/`longitude` (nullable; for the site map — geocoded from the address via OpenStreetMap Nominatim), **`overview` jsonb** (the 7 overview fields + `assignedUserIds` = ENGINEER/PROJECT_MANAGER `platform.users.id`s watching the site; staff-managed via `discovery:sites:manage`), paging info |
| `discovery_calling_policies` | customer-defined outbound dialling restrictions: name, description, allow_local/national/international/service/premium. Seeded with Unrestricted / International / National / Local |
| `discovery_number_ranges` | **`sitecode`** FK -> `discovery_sites.sitecode` (ON UPDATE CASCADE / ON DELETE SET NULL), range_start, range_end, kind (`new`/`port`/`retain`), carrier, loa_sent, loa_completed, comments. Adding a range generates the `phone_numbers` inventory |
| `phone_numbers` | one row per E.164 (`e164` unique). status (`available`/`reserved`/`assigned`), holder_type (`user`/`cap`/`resource_account`/`analogue`) + holder_id — **at most one holder**; unique per holder except resource accounts (which may hold several). Assignment is atomic |
| `discovery_users` | **`site_id`** FK -> `discovery_sites.id` (ON DELETE SET NULL), upn (unique), display_name, calling_policy_id, caller_id (`user`/`anonymous`/`main_number`), voicemail_enabled + language, requires_handset + model, access_port_id, comments, `requested_number` (free text — the number the customer asked for via the Excel import; reconciled against inventory in Design & Build, flagged on the Users tab when it differs from the assigned one). Assigned number tracked on `phone_numbers` |
| `discovery_caps` | **`site_id`**, display_name, upn, device_model, calling_policy_id, caller_id, access_port_id, comments |
| `discovery_resource_accounts` | **`site_id`**, name, kind (`auto_attendant`/`call_queue`), directory_entry, business_hours, who_answers, ooh_action, exception_conditions/action, holiday, advanced_features, comments. Holds 0..n numbers |
| `discovery_flows` | free-form notes: **`site_id`**, `kind`, `name`, `description` + optional `diagram_attachment_id` |
| `discovery_network` | **`site_id`**, e911 subnets: `scope` (internal/external), `subnet`, `mask`, `network_type` (LAN/WLAN), optional **`vlan_id`**, and `location` = one of `NETWORK_LOCATIONS` (External Subnet / User VLAN / Voice/VOIP VLAN / Wireless VLAN) — drives the live network diagram on the Network (E911) tab |
| `attachments` | id, filename, content_type, bytes (bytea) or object key, uploaded_by |

`discovery_users.tenant_user_id` links a captured user to the real tenant user found by Discovery (matched on `lower(upn)`).

### Discovery (live tenant inventory) — see [`DISCOVERY.md`](DISCOVERY.md)
| Table | Notes |
|-------|-------|
| `tenant_discovery_runs` | id, connection_id → `connections`, status (`queued`/`running`/`completed`/`failed`), started_by, started/finished_at, `scope_types` text[] (object types a partial run covered; NULL = full), `progress` jsonb (`{step, completed[], counts{}, changed{}, errors[]}`), `summary` jsonb, error |
| `tenant_objects` | **current snapshot**, one row per object: `object_type` (`TENANT_OBJECT_TYPES`), `object_key` (unique per type), display_name, `data` jsonb (GIN), generated `search` tsvector (GIN), first/last_seen_run_id, discovered_at, `content_changed_at` (when `data` last actually changed), `removed_at` (tombstone when a later successful run no longer returns it) |
| `tenant_object_versions` | one row per actual change to an object on a run: object_id → `tenant_objects` (cascade), run_id → `tenant_discovery_runs` (set null), denormalised object_type/object_key/display_name, `change_kind` (`added`/`updated`/`removed`/`readded`), `changed_fields` text[], `before`/`after` jsonb, changed_at — powers the History button and the per-run Changes tab |
| `tenant_users` | hot projection of `Get-CsOnlineUser`: object_id, `upn` (unique on lower), entra_id, display_name, account_type, account_enabled, enterprise_voice_enabled, line_uri, telephone_numbers jsonb, feature_types text[], assigned_plans jsonb, usage_location, department, job_title, interpreted_user_type, `policies` jsonb (name per policy type), effective_policy_assignments jsonb, when_changed, last_seen_run_id, removed_at |
| `tenant_policies` | hot projection of policy definitions: object_id, `policy_type` (`TENANT_POLICY_TYPES`), identity, name, is_global, `data` jsonb, last_seen_run_id, removed_at — the reference for Design & Build policy pickers |
| `tenant_discovery_config` | one row: `filter_users` boolean (default true — a run stores only `User` accounts licensed for Teams; set false per customer to store every enabled user), `notify_on_complete` boolean (default true — email the run's starter when it reaches a terminal state), updated_by/at |

Deferred from the template (later pass): Analogue/SIP/paging devices, the
Features & Settings feature-discovery questionnaire, detailed E911 tables.

### Design & Build
Mirrors the build sheet, organised **per site** (same shape as Data Collection -
a rollup page links into a per-site workspace; see `docs/DEPLOYMENT.md`). Every
row carries a required `site_id` FK -> `discovery_sites.id` and a `discovery_*_id`
link to the row it was bulk-seeded from ("Populate from Discovery"), so
re-populating is idempotent. `POST .../build/reset {site_id}` wipes every
build_users/build_caps/build_resource_accounts row for a site (releasing any
phone_numbers they held) so it can be Populated from Discovery again from
scratch - Data Collection and the customer tenant are untouched.
| Table | Maps to sheet | Selected columns |
|-------|---------------|------------------|
| `build_users` | USERS | **site_id**, discovery_user_id, upn (unique per site), did, ext, e164, number_type (`DirectRouting`/`CallingPlan`/`OperatorConnect`/`SharedCalling`), revoke_ev, hold_uri, action, migration_wave, `policies` jsonb (keyed by `PolicyKey` from `@tvmf/shared` - voice_routing_policy/dial_out_policy/shared_calling_policy/dial_plan/calling_policy/call_hold_policy/call_park_policy/caller_id_policy/voice_app_policy/voicemail_policy/emergency_calling_policy/emergency_call_routing_policy/ip_phone_policy), `voicemail` jsonb (`{enabled, language}` - Populate copies this from discovery_users, the actual `voicemail_policy` Teams policy name is still the engineer's own call), call_forwarding/delegates/pickup_group jsonb (schema'd, not yet surfaced in the UI or deployed - next increment), comments, `validation` jsonb (last "Validate" snapshot - live-tenant check results, computed live on every read via `BuildValidationService`), `status` jsonb, `errors` text.
Design & Build **imports a copy** of the number Data Collection already has
claimed for that user (via the shared `phone_numbers` inventory,
`discovery_users`/`discovery_caps`' own `phone_number_id`) into `e164` at
Populate time - Data Collection's own claim is never touched, so its Number
column keeps showing it too; this is the source input record, not something
Populate consumes. `GET .../build/users` and `.../build/caps` also join in
read-only reference fields from the linked discovery row - `requested_number`
(the free-text ask, separate from the actual imported number, flagged if it
no longer matches `e164`), `requested_caller_id`, and (users only)
`requested_voicemail_enabled`/`requested_voicemail_language` - shown for the
engineer to act on, never auto-written into a policy (there's no
customer-value -> Teams-policy-name mapping to assume). `validation.
numberConflict` flags an `e164` that's also the target on *another*
build_users/build_caps/build_resource_accounts row anywhere in the tenant -
the real risk once numbers are imported as independent copies rather than a
single shared claim. |
| `build_caps` | CAPS | as `build_users` (its own discovery_cap_id) plus function, display_name, phone_model, device_config_profile, mac_address, serial_number, phone_location, lan_jack |
| `build_resource_accounts` | derived | **site_id**, discovery_resource_account_id, upn, display_name, kind (`auto_attendant`/`call_queue`), location_id, phone_number, number_type, voice_routing_policy, `application_id` (set once `New-CsOnlineApplicationInstance` has run and the account is licensed - gates the number/policy phase, see `docs/DEPLOYMENT.md`), status jsonb, errors |
| `build_auto_attendants` | AUTO ATTENDANTS | name, resource_accounts (jsonb), language, timezone, dial_by_name scope/exclusions, default_call_flow (jsonb), menu_options (jsonb), after_hours (jsonb), holidays (jsonb), voice_app_admins (jsonb) |
| `build_call_queues` | CALL QUEUES | name, resource_accounts (jsonb), routing_method, presence_based, agent_alert_time, agents (jsonb), overflow (jsonb), timeout (jsonb), music_on_hold, greeting (jsonb) |
| `build_m365_groups` | M365 GROUPS | name, email, description, used_for_voicemail, owners (jsonb), members (jsonb), group_id |
| `build_holidays` | HOLIDAYS | name, dates (jsonb) |
| `build_policies_catalog` | Policies | cached list of the tenant's existing policies per type, refreshed on connect |

### Deployment & Audit
| Table | Notes |
|-------|-------|
| `connections` | id, started_by, method (`device_code`), status (`pending`/`active`/`expired`/`closed`), user_code, verification_uri, tenant_domain, upn, scopes, started_at, expires_at, closed_at — **no tokens**. (Migration 0014 added `graph_*` columns for a Graph device-inventory sign-in; 0015 drops them — the Graph device API was retired.) |
| `deployments` | id, connection_id, mode (`dry_run`/`execute`), scope jsonb (`{siteId, sheets, waves?, rowIds?}` - every run acts on one site's Build rows at a time), status, created_by, started_at, finished_at, summary jsonb (counts: applied/skipped/failed/whatif) |
| `deployment_changes` | id, deployment_id, seq, at, operator_user_id, correlation_id, object_type (`user`/`cap`/`resource_account`/`aa`/`cq`/`group`), object_id, cmdlet, parameters jsonb (redacted), before jsonb, after jsonb, result (`applied`/`skipped`/`failed`/`whatif`), message — **append-only** |
| `deployment_scripts` | id, deployment_id, filename, kind (`ps1`/`txt`), content — the "What-If" output |

### Service Handover
| Table | Notes |
|-------|-------|
| `handover_packs` | id, version, status (`draft`/`issued`), generated_by, generated_at, source jsonb (snapshot refs), file (bytea, .docx) |
| `handover_sections` | pack_id, key, title, ordinal, content jsonb — one per docx section (Site Information, Phone Numbers, Teams Users, CAPS, Analog Phones, Paging, Auto Attendants, Call Queues, Resource Accounts, Voicemail Groups, MS Teams Configuration, Network Data, Outstanding Actions) |

### Common
| Table | Notes |
|-------|-------|
| `audit_log` | id, at, actor_user_id, actor_email, action, target_type, target_id, detail jsonb |

Enum-like value lists (number types, policy kinds, routing methods, greeting
types, call-forward target types, voicemail answering rules, languages,
timezones) live in `packages/shared/src/domain.ts` so the API, the worker and
the web forms share one definition.
