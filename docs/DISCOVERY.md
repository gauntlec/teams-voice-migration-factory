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
   goes and updating `progress` (`{step, completed[], counts{}, changed{}, errors[]}`),
   which the page polls every 3 s.
4. Objects a successful step no longer returned are tombstoned (`removed_at`), kept
   for history and hidden by default. A step that fails is recorded in
   `progress.errors` and the run carries on; only a lost sign-in fails the run.
5. Sessions expire after `TEAMS_SESSION_TTL_MINUTES` idle (default 60) or when the
   worker restarts — tokens only ever live inside the pwsh process.

### Who may use a session

A `connections` row belongs to the engineer who signed it in (`started_by`).
Only that engineer, or a `SUPER_ADMIN`, can run a sync on it — any other
engineer gets a 403 and must start their own connection. The Discovery page
reflects this: a normal engineer only ever sees their own live session; a
`SUPER_ADMIN` sees an **Active sessions** list of every connected engineer
(name, signed-in-as UPN, age) and picks which session a run uses. A
`SUPER_ADMIN` running on someone else's session is recorded in the audit log
(`sessionOwnerId`, `ranAs`). See `docs/SECURITY.md`.

### Selective sync

A run can cover **part** of the tenant. The *Sync part of the tenant* control on
the connection card offers the eight steps as checkboxes; a step with more than
one object type (voice routing, emergency, voice apps) expands to tick individual
types (e.g. just call queues). The selection is sent as `scopeTypes` on
`POST runs` and stored as `tenant_discovery_runs.scope_types` (`NULL` = a full
run). The worker filters `STEP_CMDLETS` to the requested types, runs only those
steps, and **only tombstones within the covered types** — a "users only" run
never touches policies. Useful on large tenants to refresh one area quickly.

### Version history

`upsertObject` compares each incoming record against the stored one (order-
independent JSON). When the data (or display name) actually changed it writes a
`tenant_object_versions` row: `change_kind` (`added` / `updated` / `removed` /
`readded`), `changed_fields` (the top-level `data` keys that differ) and the full
`before` / `after`. `tenant_objects.content_changed_at` tracks when the data last
changed (vs `discovered_at` = last seen). The run's `progress.changed` /
`summary.changed` tally the four kinds.

Seen in the UI three ways: **counts on the Latest run card** (`+N added · N
changed · N removed`), a **Changes tab** (pick any past run, filter by type, see
before/after per item), and a **History** button on every item (users, policies,
numbers, …) showing that item's timeline.

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

**No device hardware inventory.** Phones, Teams Rooms, panels and SIP devices
have no `Get-Cs*` cmdlet, and the Graph `/teamwork/devices` API was **retired by
Microsoft (Nov/Dec 2025)** with no replacement (a short-lived attempt to use it
was reverted — commit `93031b6` then reverted). Instead the **Devices tab** shows
*phone endpoints* derived from the snapshot already collected:
`TenantDiscoveryService.listEndpoints()` returns Common Area Phone accounts
(`tenant_users` with an `MCOCAP` service plan) and phone-enabled resource
accounts, with their number and calling / IP-phone policy. `GET
.../tenant-discovery/endpoints`. No second sign-in, no extra step, no new
storage.

## Storage (tenant schema, migrations 0009 + 0010)

- `tenant_discovery_runs` — one row per run (status, progress, summary, error).
  `scope_types` = the object types a partial run covered (`NULL` = full).
- `tenant_objects` — **current snapshot**, one row per object (`object_type`,
  `object_key` unique). Raw record in `data` (JSONB, GIN-indexed) plus a generated
  `search` tsvector; `first/last_seen_run_id`, `content_changed_at`, `removed_at`.
- `tenant_object_versions` — one row per **actual change** to an object on a run:
  `change_kind`, `changed_fields[]`, `before`/`after` (JSONB), `run_id`. Denormalised
  `object_type`/`object_key`/`display_name` so the per-run changelog is one scan.
  Cascades with `tenant_objects` on purge.
- `tenant_users` — hot projection of `Get-CsOnlineUser` for lists, lookups and
  autofill: UPN (unique on lower), EV enabled, `line_uri`, `telephone_numbers`,
  `feature_types` (Teams / PhoneSystem / CallingPlan …), `assigned_plans`, usage
  location, department, title, `policies` (name per policy type),
  `effective_policy_assignments`.
- `tenant_policies` — hot projection of policy definitions (`policy_type`,
  `identity`, `name`, `is_global`, `data`). `data` holds only the settings: the
  module's XML-wrapper keys (`Key`, `SchemaId`, `DefaultXml`, `AuthorityId`,
  `XmlRoot`, …) are stripped by the worker (`POLICY_NOISE_KEYS` in
  `apps/worker/src/discovery/run.ts`); the untouched record stays on `tenant_objects`.
- Phone numbers: `Get-CsPhoneNumberAssignment` only returns the assignee's Entra
  object id (`AssignedPstnTargetId`). The worker resolves it against the users and
  resource accounts stored earlier in the same run and adds
  `AssignedTo {upn, displayName, kind}` to the stored record, so the Phone numbers
  tab shows a name rather than a GUID.
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
`POST|GET connections`, `GET connections/:id`,
`POST runs` (`{connectionId, scopeTypes?}`), `GET runs`, `GET runs/:id`,
`GET runs/:id/changes?type=&q=&page=&limit=` (the per-run changelog),
`GET summary`, `GET objects?type=&q=&page=&limit=`, `GET objects/:id`,
`GET objects/:id/versions` (an object's change timeline),
`GET users?q=`, `GET users/lookup?upn=`, `GET policies?policyType=&q=`,
`GET import-users/preview`, `POST import-users`,
`DELETE /t/:tenantId/tenant-discovery` (purge — see below).
Other modules should read `GET policies` (e.g. Design & Build policy pickers) and
`GET users/lookup` rather than querying the tables directly.

### Purge

`DELETE /t/:tenantId/tenant-discovery` (`tenantdiscovery:run`, and the **Delete
discovered data** button on the Overview tab) wipes the whole inventory for one
customer: `tenant_objects` (which cascades to `tenant_users`, `tenant_policies`
and `tenant_object_versions`), then `tenant_discovery_runs`. Data Collection users are kept —
their `discovery_users.tenant_user_id` link is set null by the FK. `connections`
are untouched. Blocked while a run is `queued`/`running`. Not reversible; re-run
discovery to rebuild. Audited as `tenant_discovery.purged` (tenant + platform)
with the deleted row counts.

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
- **Large tenants.** A run writes ~one upsert per object, so a tenant with tens of
  thousands of users/policies is a sustained write load on the shared Postgres.
  Guards: the worker reads the current snapshot for a type once (not per row) and
  batches the `tenant_object_versions` inserts; `summary` runs its queries
  sequentially (never holds >1 pooled connection); the Discovery page polls
  `summary` every 12 s while a run is going (the live progress bar uses the cheap
  `GET runs/:id` instead); pool size is `PG_POOL_MAX` (default 20) per process.
  On a worker restart the startup sweep fails any run left `queued`/`running`.
- **`Get-CsOnlineUser` on a big tenant.** It has no `-Skip`, so instead of one
  opaque multi-minute call the worker fetches it in **disjoint `-Filter`
  buckets** (`userBuckets()` in `cmdlets.ts`): users split by first UPN
  character (`a*`…`9*` + an "other" catch-all), then one call per remaining
  `AccountType` (ResourceAccount, Guest, …). Each call is a small fraction of the
  tenant, so the fetch phase shows real progress ("Fetching users: 8,400 so far
  (users m*, 13/42)…") and no single call can time out. Records are also
  `Select-Object`'d to the ~40 properties `projectUser` stores (depth 6, so the
  nested `AssignedPlan` licence fields always serialise). One bad bucket is
  recorded in `progress.errors` and skipped, not fatal. Per-cmdlet timeout is
  `TEAMS_COMMAND_TIMEOUT_MS` (default 15 min).
- **The user filter (Teams-licensed candidates only).** By default an
  `AccountType='User'` record is stored only if it is licensed for Teams —
  `isTeamsCandidate()` in `run.ts`: any `FeatureTypes` entry, or an active
  (`Enabled`/`Warning`) `MCO*`/`TEAMS*` service plan in `AssignedPlan`. It
  **fails open**: a record with no licence fields at all is kept, and a run-level
  **probe** on the first slice of real `User` records turns the filter off
  entirely (with a visible `progress.filterDisabledReason`) if `Get-CsOnlineUser`
  returned no licence data for anyone — never filter blind. Resource accounts and
  SfB-on-prem users are never filtered. However many `User` accounts were left
  out is recorded in `progress.skipped.notLicensed` and the run `summary`, and
  shown on the run card, so a low user count is always explained.
  The filter is on by default **per customer**
  (`tenant_discovery_config.filter_users`, toggled on the Discovery page /
  `PATCH .../tenant-discovery/settings`) — turn it off once for a small customer
  and every run stores all enabled users. A single run can also be widened with
  the "Include accounts not licensed for Teams" tick. `startRun` resolves the
  customer default and that per-run toggle into one `filterUsers` flag on the job.
- **A slow cmdlet no longer kills the run.** The runner only aborts with
  "lost the tenant sign-in" when the pwsh session is genuinely gone
  (`executor.alive` is false, or the error names a dropped connection). A plain
  command timeout while the child is still up is recorded as a step error and the
  run carries on to the next step; re-run just that step with a selective sync.
- **Completion email.** When a run reaches a terminal state the worker emails the
  person in `started_by` (`notifyRunComplete()` in `run.ts`) with the outcome,
  scope, duration, change counts and per-type breakdown, via the standard `mail`
  queue and the branded layout. On by default per customer
  (`tenant_discovery_config.notify_on_complete`, toggle on the Discovery page).
  Best-effort — a mail failure is logged and never fails the run; with `SMTP_HOST`
  unset the message is logged like any other.

### How the worker drives pwsh (hard-won details — keep them)

- The session is `pwsh -NoLogo -NoProfile` with **plain piped stdin**. Do not use
  `-Command -` / `-File -`: on pwsh 7 those read stdin to EOF before running
  anything, so a long-lived session never executes.
- Every script is sent as **one line**: `iex ([Text.Encoding]::Unicode.GetString(
  [Convert]::FromBase64String('…')))` followed by a `__END__<uuid>` marker. The
  stdin host echoes each input line back; the parser only reacts to marker lines
  and `__JSON__` / `__ERR__` / `__SIGNIN__` prefixed output.
- `Connect-MicrosoftTeams -UseDeviceAuthentication` writes
  `To sign in, use a web browser to open the page https://login.microsoft.com/device
  and enter the code XXXXXXXXX to authenticate.` to **stderr**, **without a trailing
  newline** (the cursor parks there until sign-in completes). The executor therefore
  matches the prompt against the partial stdout *and* stderr buffers, not just
  complete lines. A stuck "Requesting a device code…" almost always means this
  parsing broke.
- The pwsh child holds the session; if the worker restarts, every `pending`/`active`
  connection row is expired on start-up (`expireOrphanedConnections`) and the UI
  asks for a fresh sign-in. BullMQ may re-deliver an interrupted `connection.start`
  job to the new worker, which simply produces a new code.
