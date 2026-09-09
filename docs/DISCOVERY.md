# Discovery — live customer-tenant inventory

**Who:** SUPER_ADMIN and ENGINEER only (`tenantdiscovery:read` / `tenantdiscovery:run`).
**Where:** Migration → **Discovery** (`/discovery`), per customer.
**What:** a point-in-time snapshot of the customer's live Microsoft Teams tenant —
every user with their Teams voice state and licence-derived features, resource
accounts, phone numbers, **every voice policy definition**, PSTN routing,
emergency locations, auto attendants, call queues and schedules — stored in
Voxshift so Data Collection, Design & Build and Deployment can reference reality.

## How a run works

1. **Connect.** The engineer clicks *Connect to customer tenant*. The API inserts a
   `connections` row (the same table Deployment uses) and queues `connection.start`.
   The worker starts a `pwsh` child running the **MicrosoftTeams PowerShell module**
   and calls `Connect-MicrosoftTeams -UseDeviceAuthentication`. The device code is
   written to the row; the page shows it with the sign-in link.
2. The engineer signs in at `microsoft.com/devicelogin` with a **Teams Administrator**
   account for that customer. No custom Entra app or admin consent is needed — the
   module uses Microsoft's first-party app. The row flips to `active` with the UPN.
3. **Run discovery.** The API inserts a `tenant_discovery_runs` row and queues
   `tenant_discovery.run`. The worker walks the steps below, upserting objects as it
   goes and updating `progress` (`{step, completed[], counts{}, errors[]}`), which the
   page polls every 3 s.
4. Objects a successful step no longer returned are tombstoned (`removed_at`), kept
   for history and hidden by default. A step that fails is recorded in
   `progress.errors` and the run carries on; only a lost sign-in fails the run.
5. Sessions expire after `TEAMS_SESSION_TTL_MINUTES` idle (default 60) or when the
   worker restarts — tokens only ever live inside the pwsh process.

| Step | Cmdlets | Stored as (`object_type`) |
|---|---|---|
| tenant | `Get-CsTenant` | `tenant` |
| users | `Get-CsOnlineUser` (all account types, paged 500) | `user` → also `tenant_users` |
| resource_accounts | `Get-CsOnlineApplicationInstance` | `resource_account` |
| numbers | `Get-CsPhoneNumberAssignment` (paged) | `phone_number` |
| policies | `Get-Cs<Type>` for each of `TENANT_POLICY_TYPES` (calling, voice routing, dial plan, emergency calling / routing, voicemail, caller ID, call park, call hold, IP phone, shared calling, voice apps, meeting, messaging, app setup) | `policy` → also `tenant_policies` |
| voice_routing | `Get-CsOnlinePSTNGateway`, `Get-CsOnlinePstnUsage` (one object per usage), `Get-CsOnlineVoiceRoute` | `pstn_gateway`, `pstn_usage`, `voice_route` |
| emergency | `Get-CsOnlineLisLocation`, `Get-CsOnlineLisCivicAddress` | `emergency_location`, `civic_address` |
| voice_apps | `Get-CsAutoAttendant`, `Get-CsCallQueue` (paged 100), `Get-CsOnlineSchedule` | `auto_attendant`, `call_queue`, `schedule` |

The step → cmdlet → key/name mapping is data in
`apps/worker/src/discovery/cmdlets.ts`; adding an object type is one entry there plus
a label in `packages/shared/src/domain.ts`.

## Why PowerShell, not Graph

Microsoft Graph now has Teams-admin endpoints (`/admin/teams/userConfigurations`,
number management), but they need **our own Entra app with admin-consented
permissions** (`User.Read.All`, `Organization.Read.All`, …) — something a Teams
Administrator cannot grant — and Graph still has **no endpoint for policy
definitions** (the settings inside a calling or voice-routing policy). The
PowerShell module gives everything with the access the engineer already has. Graph
can be layered in later behind the same `TeamsExecutor` if a customer consents.

## Storage (tenant schema, migration 0009)

- `tenant_discovery_runs` — one row per run (status, progress, summary, error).
- `tenant_objects` — **current snapshot**, one row per object (`object_type`,
  `object_key` unique). Raw record in `data` (JSONB, GIN-indexed) plus a generated
  `search` tsvector; `first/last_seen_run_id`, `removed_at`.
- `tenant_users` — hot projection of `Get-CsOnlineUser` for lists, lookups and
  autofill: UPN (unique on lower), EV enabled, `line_uri`, `telephone_numbers`,
  `feature_types` (Teams / PhoneSystem / CallingPlan …), `assigned_plans`, usage
  location, department, title, `policies` (name per policy type),
  `effective_policy_assignments`.
- `tenant_policies` — hot projection of policy definitions (`policy_type`,
  `identity`, `name`, `is_global`, `data`).
- `discovery_users.tenant_user_id` — the Data Collection user's link to the real one.

Postgres was chosen over Elasticsearch on purpose: a tenant is thousands of users
and hundreds of policies, and JSONB + GIN + `tsvector` searches that instantly
without a second datastore to run, sync and back up.

## Data Collection link

- **Autofill:** on the site *Users* tab, leaving the UPN field calls
  `GET /t/:id/tenant-discovery/users/lookup?upn=` and prefills the display name,
  showing "Found in tenant: +1913… · Enterprise Voice on · Calling policy X".
- **Link:** `addUser` / `updateUser` set `tenant_user_id` when the UPN matches a
  live tenant user; the table shows a **Linked** badge.
- **Bulk import:** Discovery → Users → *Import into Data Collection…* creates a
  Data Collection user for every discovered (optionally EV-enabled) tenant user
  not yet captured, under a chosen site, and links unlinked matches. Respects the
  draft/submitted/accepted lock.

## API

`/t/:tenantId/tenant-discovery/…` (all `TenantGuard`):
`POST|GET connections`, `GET connections/:id`, `POST|GET runs`, `GET runs/:id`,
`GET summary`, `GET objects?type=&q=&page=&limit=`, `GET objects/:id`,
`GET users?q=`, `GET users/lookup?upn=`, `GET policies?policyType=&q=`,
`GET import-users/preview`, `POST import-users`.
Other modules should read `GET policies` (e.g. Design & Build policy pickers) and
`GET users/lookup` rather than querying the tables directly.

## Operations

- The worker image is `mcr.microsoft.com/powershell:7.4-debian-12` + Node 20 with the
  MicrosoftTeams module pre-installed (`apps/worker/Dockerfile`). It is larger and
  slower to build than before.
- `TEAMS_EXECUTOR=simulated` runs everything against a small fake dataset (no pwsh)
  — useful for demos and for developing the UI.
- Check the module inside the container:
  `docker exec <worker> pwsh -c "Get-Module -ListAvailable MicrosoftTeams"`.
- Nothing about the sign-in is logged except the device code line the engineer is
  meant to see; `docker logs` shows counts per step only.
