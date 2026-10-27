# Data model

Derived from the current artifacts:
- `ATTC MS Teams Build 5.3.xlsx` — sheets General, Checklist, DID Ranges,
  PORTING, USERS, CAPS, Analog GW & SIP Devices, M365 GROUPS, CALL QUEUES,
  HOLIDAYS, AUTO ATTENDANTS, Calling & Special Features, E911 LAN, Policies.
- `Teams-Migration-Build-*.ps1` — the cmdlets it runs (target state).
- `Service Hand-Over Pack V1.18.docx` — the output document sections.

## Deleting a customer

Deleting a customer (Administration > Customers, Super Admin only; [SECURITY.md](SECURITY.md#deleting-a-customer)) removes the customer's schema `tenant_<id>` with
`DROP SCHEMA ... CASCADE`, so every table in it goes without being listed. The `platform` tables are different: some rows must be removed by
name. `apps/api/src/tenants/tenant-data-inventory.ts` lists every platform column that refers to a customer and how it is handled
(`cascade`, `deleted`, `scrubbed`, `kept`). The test `tests/db/src/tenants/tenant-deletion.db.test.ts` reads the real foreign keys and column
names from `information_schema` and **fails when a table or column appears that is not on that list**. **When you add a table or column
that refers to a customer, add it to the list and make `TenantDeletionService` handle it.**

## `platform` schema

| Table | Key columns |
|-------|-------------|
| `tenants` | id (uuid), slug, name, schema_name, status (`active`/`archived`/**`deleting`**: being deleted for good, hidden everywhere, migration `0036`), **`deletion_started_at`**, **`deletion_started_by`**, **`deletion_summary`** (the counts shown before the deletion was confirmed, numbers only), …, **`monitoring_enabled`** (Monitoring switched on for this customer, default true, migration `0038`), **`sandbox`** + `sandbox_email` (a test customer - its emails are redirected, see [`EMAIL.md`](EMAIL.md)), created_by, created_at |
| `users` | id, email (citext, unique), password_hash, display_name, role (`SUPER_ADMIN`/`PROJECT_MANAGER`/`ENGINEER`/`CUSTOMER`), status (`active`/`disabled`), totp_enrolled, **`must_change_password`** (true until the forced first-sign-in reset), **`password_changed_at`**, failed_logins, locked_until, **`break_glass`** (a locally created Super Admin who keeps password + authenticator sign-in when a provider switches local passwords off; `password_hash` is `!federated` for an account that exists only through a single sign-on provider), created_at |
| `tenant_memberships` | user_id, tenant_id, added_by, **`site_ids uuid[]`** (empty = whole customer; else the `discovery_sites.id` values a CUSTOMER "site contact" is limited to — no cross-schema FK, validated by the API), created_at  (PK user_id+tenant_id) |
| `totp_secrets` | user_id (PK), secret_enc, confirmed_at |
| `auth_sessions` | id, user_id, refresh_hash, family_id, user_agent, ip, expires_at, revoked_at, replaced_by, **`amr`** (authentication methods a provider reported; empty for a password sign-in), **`idp`** (the `sso_providers.id` it came from; NULL = password), **`absolute_expires_at`** (a federated session ends here whatever refreshing does) |
| `sso_providers` | id, kind (`hub`/`oidc`), name, issuer, client_id, client_secret_enc, scopes, enabled (off by default), jit_create, require_mfa_claim, role_ceiling (oidc), role_ceiling_staff + role_ceiling_customer (hub), default_role, role_claim, role_map, email_domains, allow_local_passwords, **`staff_access`** (hub only: `allowed` default / `needs_approval` / `off`, migration `0033_sso_staff_access.sql`), last_test_at/ok/detail, created_by — see [`SSO.md`](SSO.md), [`SSO-ADMIN-GUIDE.md`](SSO-ADMIN-GUIDE.md). Migration `0031_sso.sql` also marked every existing Super Admin `break_glass`. One `hub` row at most (unique index); names unique, case-insensitive |
| `external_identities` | user_id, provider_id, subject (the provider's `sub`), email, account_kind (the hub's `staff`/`customer`), created_at, last_login_at, **`revoked_before`** (hub sign-ins that began before this are over, checked on every request; set by the hub's revocation channel), **`access_until`** (the end of an approved Voxshift staff window; NULL = no limit); unique (provider_id, subject). Never created by matching an email |
| `sso_link_requests` | provider_id, subject, email, display_name, account_kind, last_seen_at — sign-ins refused because a local account has that email; offered to an administrator to link |
| `sso_replay_guard` | key (hash of a code or token id), expires_at — authorization codes and ID tokens work once |
| `sso_access_requests` | provider_id, user_id, subject, email, requested_role / effective_role, amr, ip, status (`pending`/`approved`/`denied`/`expired`/`ended`/`cancelled`), wait_token_hash (only a hash), requested_at, request_expires_at, decided_by/at/note, window_hours / window_starts_at / window_ends_at, claimed_at, ended_at/by — a Voxshift staff sign-in waiting for approval and the window it was given ([SSO.md](SSO.md) 4.3a) |
| `invitations` | id, email, role, tenant_id, token_hash, invited_by, expires_at, accepted_at |
| `email_messages` | id, to_email (citext), to_name, template, context (jsonb), subject, status (`queued`/`sent`/`failed`/`skipped`), error, attempts, related_type + related_id, created_by, created_at, sent_at, `original_to_email` (set when a test customer's email was redirected) — the comms log; API inserts + enqueues, worker sends. See [`EMAIL.md`](EMAIL.md) |
| `feature_requests` | id, title, area, status (`new`/`under_review`/`scheduled`/`in_development`/`deployed`/`declined`), priority (`low`/`medium`/`high`/`urgent`), problem, proposal, current_behavior, examples, acceptance, constraints, affected_roles (text[]), decision_note, submitted_by, created_at, updated_at, status_changed_at/by — the feature-request board. Staff submit; a SUPER_ADMIN moves a card to `in_development` (the cue for Claude Code) and to `deployed` on ship. Values in `packages/shared/src/domain.ts` |
| `app_settings` | id (always `true` - one row), base_url (the address people reach this installation at; NULL = use `WEB_ORIGIN`), …, `sso_session_max_hours` (default 12), `sso_notify_admin_signin`, **`hub_sso_revocation_ack`** (the highest revocation line from the hub that was applied; 0 = none), updated_by, updated_at — see [`BASE-URL.md`](BASE-URL.md), [`PLATFORM-SETTINGS.md`](PLATFORM-SETTINGS.md) |
| `maintenance_notice` | id (always `true` - one row at most), message, starts_at, created_by, created_at — the release maintenance notice, see [`ARCHITECTURE.md`](ARCHITECTURE.md#operations-releasing-safely) |
| `platform_audit_log` | id, at, actor_user_id, actor_email, action, target_type, target_id, tenant_id, detail (jsonb), ip — **append-only at the database**: a trigger (`0035_audit_log_append_only.sql`) refuses UPDATE, DELETE and TRUNCATE for every account; INSERT works. A database owner can still disable the trigger, see [`SECURITY.md`](SECURITY.md) "Database access" |

## tenant `tenant_<shortid>` schema

### Data Collection (discovery)
Aligned to `Overland Park - ATTC MS Teams Telephony Discovery Template`.
| Table | Notes |
|-------|-------|
| `discovery` | one row: id, status and submitted/accepted details (no longer read: the review is per site, see `discovery_sites`), general jsonb (migration id, region, author, licensing model, contact, notes) |
| `discovery_site_changes` | changes made to a site after it was submitted, for the engineer: site_id, changed_at, actor, `entity` (User, Number range, ...), `entity_label`, `action` (added/changed/removed), `detail`, acknowledged_at/by. Written only while the site's `review_status` is not `draft`; nothing is ever locked |
| `discovery_sites` | **`sitecode`** (unique key), **`review_status`** (`draft`/`submitted`/`accepted`) with submitted_by/at and accepted_by/at, name, address, country, region, `latitude`/`longitude` (nullable; for the site map — geocoded from the address via OpenStreetMap Nominatim), **`overview` jsonb** (the 7 overview fields + `assignedUserIds` = ENGINEER/PROJECT_MANAGER `platform.users.id`s watching the site; staff-managed via `discovery:sites:manage`), paging info |
| `discovery_calling_policies` | customer-defined outbound dialling restrictions: name, description, allow_local/national/international/service/premium. Seeded with Unrestricted / International / National / Local |
| `discovery_number_ranges` | **`sitecode`** FK -> `discovery_sites.sitecode` (ON UPDATE CASCADE / ON DELETE SET NULL), range_start, range_end, kind (`new`/`port`/`retain`), carrier, loa_sent, loa_completed, comments. Adding a range generates the `phone_numbers` inventory |
| `phone_numbers` | one row per E.164 (`e164` unique). status (`available`/`reserved`/`assigned`), holder_type (`user`/`cap`/`resource_account`/`analogue`) + holder_id — **at most one holder**; unique per holder except resource accounts (which may hold several). Assignment is atomic |
| `discovery_users` | **`site_id`** FK -> `discovery_sites.id` (ON DELETE SET NULL), upn (unique), display_name, calling_policy_id, caller_id (`user`/`anonymous`/`main_number`), voicemail_enabled + language, requires_handset + model, access_port_id, comments, `requested_number` (free text — the number the customer asked for via the Excel import; reconciled against inventory in Design & Build, flagged on the Users tab when it differs from the assigned one). Assigned number tracked on `phone_numbers` |
| `discovery_caps` | **`site_id`**, display_name, upn, device_model, calling_policy_id, caller_id, access_port_id, comments |
| `discovery_voice_apps` | **`site_id`**, name (the voice app's own name), kind (`auto_attendant`/`call_queue`), `tenant_object_id` (the exact discovered voice app, GUID), directory_entry, business_hours, who_answers, ooh_action, exception_conditions/action, holiday, advanced_features, comments. Its Call flow and Design & Build row point at it |
| `discovery_resource_accounts` | **`site_id`**, `voice_app_id` (the voice app it answers for; null = none yet), name, kind, `upn`, `tenant_object_id` (the exact discovered account), comments. Holds 0..n numbers (`phone_numbers.holder_type = 'resource_account'`). A voice app has 0..n of them; a nested voice app has none |
| `discovery_flows` | free-form notes: **`site_id`**, `kind`, `name`, `description` + optional `diagram_attachment_id` |
| `discovery_network` | **`site_id`**, e911 subnets: `scope` (internal/external), `subnet`, `mask`, `network_type` (LAN/WLAN), optional **`vlan_id`**, and `location` = one of `NETWORK_LOCATIONS` (External Subnet / User VLAN / Voice/VOIP VLAN / Wireless VLAN) — drives the live network diagram on the Network (E911) tab |
| `attachments` | id, filename, content_type, bytes (bytea) or object key, uploaded_by |

`discovery_users.tenant_user_id` links a captured user to the real tenant user found by Discovery (matched on `lower(upn)`).

**Bulk delete.** The Users, Common area phones and Resource accounts tabs have
"Delete selected (N)" and "Delete all…" (typed DELETE to confirm) -
`POST .../{users|caps|resource-accounts}/bulk-delete` with `{ ids }` or
`{ site_id, all: true }` (`TelephonyService.bulkDelete`). Each row goes exactly
as a single delete would: Data Collection lock and site scope apply, its
`phone_numbers` claims return to `available`, and Design & Build rows populated
from it stay with their `discovery_*_id` link cleared (FK `ON DELETE SET NULL`).
One transaction, one audit row (`discovery.<kind>s_bulk_deleted`).

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
| `build_users` | USERS | **site_id**, discovery_user_id, upn (unique per site), did, ext, e164, number_type (`DirectRouting`/`CallingPlan`/`OperatorConnect`/`SharedCalling`), revoke_ev, hold_uri, action, migration_wave, `policies` jsonb (keyed by `PolicyKey` from `@tvmf/shared` - voice_routing_policy/dial_out_policy/shared_calling_policy/dial_plan/calling_policy/call_hold_policy/call_park_policy/caller_id_policy/voice_app_policy/voicemail_policy/emergency_calling_policy/emergency_call_routing_policy/ip_phone_policy), `voicemail` jsonb (`{enabled, language}` - the real `Set-CsOnlineVoicemailUserSettings` deploy target, editable in the Users tab; Populate seeds it from discovery_users as a starting point; distinct from `policies.voicemail_policy` above, a separate tenant-defined policy grant), call_forwarding/delegates/pickup_group jsonb (schema'd, not yet surfaced in the UI or deployed - next increment), comments, `validation` jsonb (last "Validate" snapshot - live-tenant check results, computed live on every read via `BuildValidationService`), `status` jsonb, `errors` text.
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
| `deployment_changes` | id, deployment_id, seq, at, operator_user_id, correlation_id, object_type (`user`/`cap`/`resource_account`/`aa`/`cq`/`group`), object_id, cmdlet, parameters jsonb (redacted), before jsonb, after jsonb, result (`applied`/`skipped`/`failed`/`whatif`), message — **append-only**, enforced by a database trigger (tenant `0054_audit_tables_append_only.sql`: UPDATE, DELETE and TRUNCATE are refused; a deployment that has changes therefore cannot be deleted either, though nothing deletes deployments) |
| `deployment_scripts` | id, deployment_id, filename, kind (`ps1`/`txt`), content — the "What-If" output |
| `voice_audio_files` | id, filename, content_type, byte_size (≤ 5 MB), content bytea, teams_audio_file_id, imported_at, uploaded_by - redirect audio prompts, imported to Teams by the worker in the live run that uses them (tenant `0069`) |
| `device_monitor_settings` | one row: enabled, kuma_url, status_slug, last_polled_at, last_ok_at, last_error - where the customer's Uptime Kuma status page is (tenant `0070`) |
| `device_monitors` | kuma_id (pk), name, monitor_type, group_name, sitecode, device_kind, state (up/down/pending/maintenance/unknown), since, since_exact, last_beat_at, response_ms, message, uptime_24h - one row per monitor on the status page |
| `device_status_changes` | kuma_id, name, sitecode, device_kind, from_state, to_state, at, message - every change of state seen, kept 90 days |
| `device_inventory` | id, site_code, name, kind, check_type (ping/port/snmp), address, port, snmp_version, snmp_community_enc (encrypted), snmp_username, snmp_oid, snmp_operator, snmp_expected, kuma_snmp_user (tenant `0073`), kuma_monitor_id, sync_state (pending/synced/error), sync_error, removed - the devices to watch; the worker keeps a Kuma monitor for each (tenant `0071`). `device_monitor_settings` also gains managed, kuma_admin_user, kuma_admin_pass_enc (encrypted), sync_needed, last_sync_at, last_sync_error |
| `platform.monitoring_admin` | one row: admin_user, admin_pass_enc (AES-256-GCM) - the monitoring module's administrator, ONE per installation, shared by every customer using it (platform `0037`) |
| `device_alert_settings` | one row: enabled, frequency (immediate/15m/30m/1h/4h/daily), reminder_hours (0/1/4/24), notify_engineers, notify_project_managers, recipients (extra addresses), cursor (last device_status_changes id dealt with), last_sent_at - Monitoring email alerts (tenant `0072`); `device_monitors` also gains last_alerted_at |
| `number_policy` | one row: cooloff_days (default 90, 0 = off) - the number cool-off period (tenant `0066`); `phone_numbers` gains cooling_until, cooling_reason |
| `deployment_drift` | site_id (PK, FK → `discovery_sites`), drifted, awaiting_sync, rows jsonb (`DriftRow[]`: rowId, objectType, name, state, cmdlets, lastDeployedAt), run_id, computed_at — the latest drift check for a site (tenant `0065`), replaced on every check; see DEPLOYMENT.md "Drift" |

### Service Handover
| Table | Notes |
|-------|-------|
| `handover_packs` | id, version, status (`draft`/`issued`), generated_by, generated_at, source jsonb (notes, snapshotAt, siteIds, siteCodes, sectionKeys — what the pack covers), file_id (FK → `files`, the generated .docx), issued_by, issued_at (set together when issued; a CHECK keeps `status` and `issued_at` consistent) |
| `handover_sections` | pack_id, key, title, ordinal, content jsonb (`table` / `paragraphs` / `placeholder`) — one per section in the pack; the in-app preview reads these |
| `handover_notes` | section_key (`service_support_model` / `paging` / `teams_configuration` / `outstanding_actions`), site_id (NULL = every site), body, updated_by, updated_at — hand-written text for the four template sections with no structured source. Unique per (section, site) |

Handover is customer-wide: a "site contact" (a customer user pinned to certain sites) cannot read, build or issue a pack, because a pack covers every site's data. A pack can be limited to chosen sites and sections when it is generated.

**The pack documents what is deployed.** Teams Users, Common Area Phones and
Resource Accounts come from Design & Build, each planned against Discovery's
live snapshot with the same diff a deployment makes (`planIdentityRows` /
`planResourceAccountRows`, now in `@tvmf/db` so the worker and the API share
it). A row with nothing left to change is live and is printed with the values
Teams has (number, voice routing and calling policy, voicemail) plus when
Voxshift last changed it (`deployment_changes`, execute runs, applied) or
"Already in place". Anything else - not created, not found, a different
number or policy, calling still to be removed - goes in the **Designed but Not
Yet Live** section with what differs. Voicemail is only known for accounts a
targeted check has read, so an unread value isn't treated as a difference
(shown as "designed, not checked live"). Auto attendants and call queues count
as live when Teams has one by that name; queues list their agents. Phone
Numbers say who holds each number in Teams (`tenant_users.line_uri`): In use /
Spare / Reserved. The cover says when Discovery last read Teams ("Checked
against Teams", also saved as `source.liveAsOf`), so re-run Discovery - or
rely on a deployment's automatic re-check - before generating.

Drafts are for Voxshift staff (anyone with `handover:generate`). Customers see
a pack only once it is issued - in the pack list, the preview and the Files
page - and never the Generate dialog's internal note (`source.notes`). A
draft's .docx is marked DRAFT on the cover, header and footer; issuing
re-renders the document from the pack's saved `handover_sections` (the same
snapshot, nothing re-read) with "Issued by / Issued at", stores it as a new
file and points `file_id` at it. Customers can only download an issued pack's
current file, never the superseded draft.

### Incidents (Managed Services) — see [`INCIDENT-MANAGEMENT.md`](INCIDENT-MANAGEMENT.md)

Tenant migrations `0047_incidents.sql`, `0048_incident_pause_log.sql` and `0049_incident_major_problems.sql` (`pause_log`: the closed pauses `[{from, to}]`, so working-hours clocks leave out only working time spent paused); platform `0016_tenant_inc_settings.sql` adds `tenants.inc_settings` (targets, the impact x urgency matrix, the working week `calendar` and per-priority `cover`).

| Table | Purpose |
|---|---|
| `incidents` | One per problem: `number` (per-customer sequence, `INC-0001`), title, description, `category`/`subcategory` (keys in `INC_CATEGORIES`), `site_id` (null = customer-wide), `impact`, `urgency`, `priority` (`p1`-`p4`; `priority_overridden` when staff set it), `status` (`new`/`in_progress`/`on_hold`/`restored`/`resolved`/`closed`/`cancelled`/`duplicate`), `hold_reason` (set exactly when `on_hold`), `source`, `dedup_key` (one open incident per key), `details` jsonb (category answers, example calls, callback number), `reporter_id`, `assigned_to` / `assigned_agent_id` (reserved for AI agents), `duplicate_of`, `version` (bumped on every change; writes are refused when stale), clock stamps (`acknowledged_at`, `restored_at`, `resolved_at`, `closed_at`, `cancelled_at`, `reopened_at`), pause bookkeeping (`paused_since`, `paused_seconds`), waiting reminders, `sla_notified` |
| `incident_events` | The timeline: `kind` (`created`/`status_changed`/`priority_changed`/`assigned`/`comment`/`waiting`/`resumed`/`attachment`/`link`), from/to status, `body`, `internal` (staff-only), `actor_type` (`user`/`agent`/`system`), `author_id`, `meta` jsonb, `idempotency_key` (unique per incident, for agent retries) |
| `incident_items` | What the incident is about or links to: `kind` (`site`/`user`/`number`/`call_queue`/`auto_attendant`/`cap`/`service_request`/`deployment`/`number_port`) and a text `ref`; unique per incident |
| `incident_watchers` | Customer users who follow an incident |
| `problems` | PRB-0001: `title`, `description`, `category`/`subcategory` (the kind of incident it causes), `status` (`investigating`/`known_error`/`fix_planned`/`resolved`), `root_cause`, `workaround` (team), `customer_note` (shown to customers before they raise a matching incident), `owner_id`, `resolved_at` |
| `incident_reviews` | One per incident: `status` (`draft`/`shared`), `summary`, `cause`, `went_well`, `went_badly`, `actions` jsonb (`[{text, owner, due, serviceRequestId}]`), who wrote and shared it |

`incidents` also gained (0049): `major`, `major_declared_at/_by`, `major_ended_at`, `lead_id`, `comms_id`, `update_interval_minutes`, `next_update_due_at`, `update_reminded_at`, `update_escalated_at`, `parent_id` (the major incident this is a child of) and `problem_id`; a major incident must have a lead and comms owner. New event kinds: `major_declared`, `major_update`, `major_ended`, `child_linked`, `child_unlinked`, `problem_linked`, `review_shared`. Platform `inc_settings.stakeholders` lists the customer's named contacts.

`incidents` also gained (0050): `agent_hold` (a person took the incident over; the agent is read-only until it is handed back). `assigned_agent_id` is now in use.

| Table (per customer) | Notes |
|---|---|
| `incident_claims` | One live lease per incident (unique while `released_at` is null): `agent_id`, `note`, `started_at`, `expires_at` (a heartbeat pushes it out), `released_at`, `release_reason` (`released`/`expired`/`revoked` = a person took over/`handed_off`) |
| `incident_actions` | An agent's proposals and what became of them: `agent_id`, `kind`, `action_class`, `params` jsonb, `rationale`, `risk`, `state` (`proposed`/`approved`/`rejected`/`running`/`done`/`failed`/`expired`), `decided_by`/`decided_at`/`decision_note`, `result` jsonb, `error`, `expires_at`, `finished_at` |

Platform schema (`platform`, migration 0017): `agents` (name, kind, status, scopes), `agent_tokens` (sha256 hash of the secret, hint, scopes, expiry, IP allow-list, last used), `agent_customer_policy` (agent x customer: `enabled`, `autonomy` jsonb), `agent_kill_switch` (one row: all assistants off, note), `agent_events` (outbox: tenant, incident, kind, payload; kept 14 days), `agent_webhooks` (URL, encrypted signing secret, event kinds, active, `cursor`, consecutive `failures`, next attempt), `agent_requests` (idempotency keys with the stored response). `tenants.agents_enabled` is the per-customer switch. `agents.builtin_key` (0018) marks the assistants Voxshift ships (`triage`/`diagnose`/`comms`; unique, no tokens).

| `incident_diagnostics` | Results of the read-only diagnostic runbooks (0051): `runbook`, `input`, `subject`, `status` (`ok`/`warn`/`fail`/`unknown`), `summary`, `findings` jsonb, `data_as_of` (the Discovery behind it), `actor_type`/`run_by`, `proposal_id`. Incident events gained kind `diagnostic` |

Attachments use the `files` table (category `incident_attachment`, `source_type` `incident`).

Service requests gained (0052): `assigned_agent_id`, `agent_hold`, `incident_id` (the incident it was raised for or is linked to); `service_request_events` gained `actor_type`, `meta` and the kinds `claim_started`/`claim_released`/`handoff`/`proposal`/`proposal_decided`/`whatif`.

| Table (per customer) | Notes |
|---|---|
| `service_request_claims` | One live lease per request (unique while `released_at` is null): `agent_id`, `note`, `started_at`, `expires_at`, `released_at`, `release_reason` |
| `service_request_actions` | An assistant's proposals on a request: `kind` (`comment`/`status`/`external`), `action_class`, `params`, `rationale`, `risk`, `state`, `decided_by`, `connection_id` (the approver's tenant session, for a deploy), `fingerprint` (SHA-256 of the exact commands approved), `result`, `error` |

Platform: `agent_events.request_id` (0019); `agents.builtin_key` may be `changes` (0020); `agents.works_on` (0024: `text[]`, any non-empty subset of `incidents`, `service_requests`; existing assistants became both, the built-in ones were narrowed to their one job).

Chunk 8 (see [INTAKE.md](INTAKE.md)): tenant `incident_knowledge` (0053: `title`, `category`/`subcategory`, `symptoms`, `fix`, `customer_text`, `source_incident_id`, `helpful`/`not_helpful`, `archived`). Platform: `intake_sources` (0021: per customer alert sources with `kind`, `config`, `secret_hash`, `last4`, `ip_allow`, `enabled`, `alerts_received`), `inbound_reply_tokens`, `inbound_email_log` and `email_messages.reply_to` (0022), `msps.teams_webhook_enc` / `teams_notify` and the `msp_notifications` outbox (0023). Incident `source` may be a monitoring source name; the timeline actor may be `system`.

### Common
| Table | Notes |
|-------|-------|
| `audit_log` | id, at, actor_user_id, actor_email, action, target_type, target_id, detail jsonb — append-only at the database, same trigger as `deployment_changes` (tenant `0054`) |

Enum-like value lists (number types, policy kinds, routing methods, greeting
types, call-forward target types, voicemail answering rules, languages,
timezones) live in `packages/shared/src/domain.ts` so the API, the worker and
the web forms share one definition.
