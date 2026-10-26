# Deployment

How a Design & Build target configuration gets applied to a customer tenant.
Grounded in the real `Teams-Migration-Build.ps1` script and `ATTC MS Teams
Build 5.3.xlsx` workbook, mapped onto this platform's own tables.

## Scope is always one site

Design & Build is organised per site (`docs/DATA-MODEL.md`) - a `build_users`/
`build_caps`/`build_resource_accounts` row always belongs to exactly one
`discovery_sites` row. A deployment run inherits that: `POST
/t/:id/deployments` takes `scope: { siteId, sheets, waves?, rowIds? }`, and the
worker filters every `build_*` query in the run to `site_id = scope.siteId`.
The live tenant sign-in itself (`connections`) is **not** site-scoped - one
sign-in covers every site in the tenant, since it's the same customer admin
account either way.

## Modes

- **`dry_run`**: every cmdlet is rendered to text and written to
  `deployment_scripts` (kind `ps1`) instead of being sent to the tenant.
  `deployment_changes.result = 'whatif'`.
- **`execute`**: cmdlets run live via the connection's `PwshTeamsExecutor`,
  wrapped the same way the reference script does (`-EA Stop`, catch, record).
  `deployment_changes.result` is `'applied'` or `'failed'`.

Every cmdlet - dry-run or executed - gets one `deployment_changes` row
(append-only, `docs/SECURITY.md`), so the change history is identical either
way; only whether it actually reached the tenant differs.

A customer flagged **Teams read-only** (`platform.tenants.teams_read_only`,
`docs/SECURITY.md` "Per-customer read-only safeguard") overrides `execute`
the same way the resource-account `deferred` gate below overrides both
modes: every cmdlet is forced to `whatif` before it reaches the executor,
regardless of what mode was requested or who requested it.

## Dependency ordering within a run

`apps/worker/src/main.ts`'s `handleDeploymentRun` always processes sheets in
this fixed order, regardless of the order `scope.sheets`/`scope.rowIds` were
given in: **users/caps -> resource accounts -> call queues -> auto
attendants**. Within that:

- **A Call Queue's agents / an Auto Attendant's -Operator or menu-option
  targets, and their own build_users row.** If an operator selects specific
  Call Queue/Auto Attendant rows for a run (via `rowIds`) without separately
  selecting the Build Users row(s) those rows reference, `DeploymentService.
  expandScopeWithDependencies` silently adds those build_users row ids (and
  the `users` sheet, if it wasn't already included) to the run before it's
  queued - so the referenced person's own Enterprise Voice/number/policy
  config deploys first, in the same run, rather than the operator having to
  notice the dependency and select it themselves. A whole-site run (no
  `rowIds` filter) already covers every sheet in full and needs no expansion.
  Purely additive: it never removes or reorders what was already selected.
- **A Call Queue created in this run, targeted by an Auto Attendant deployed
  later in the same run** (a menu option or -Operator transferring to that
  queue). Discovery's `tenant_objects` snapshot - what `AutoAttendantCrossRef`
  normally resolves same-site AA/CQ targets against - only updates on its own
  periodic sync, so a queue this run just created via `New-CsCallQueue` has no
  entry there yet. `refreshCrossRefEntry` closes that gap with one targeted
  live `Get-CsCallQueue -NameFilter <name>` lookup immediately after a queue
  is newly created (never for an existing one being updated - no lookup
  needed, its identity is already known), so it resolves as a valid target for
  the rest of the run.
- **One Auto Attendant created in this run, targeted by another Auto
  Attendant in the same batch** (a nested menu, e.g. "Sales" transferring
  back to "Reception"). `orderAutoAttendantRowsByDependency` topologically
  sorts the batch so a row deploys after any same-batch Auto Attendant it
  targets, and the same `refreshCrossRefEntry` lookup (via
  `Get-CsAutoAttendant -NameFilter`) runs after each newly-created one so a
  later row in the batch can resolve it. A same-batch cycle (A transfers to
  B, B transfers to A) can't be fully ordered either way and is left as
  encountered - exactly as before this ordering existed, just no worse.

None of this is needed for a Call Queue's own overflow/timeout/no-agent
targets - those are plain PSTN numbers/SIP addresses
(`normalizePstnTarget`), never a same-site AA/CQ `buildId` reference, so
call_queues has nothing to topologically sort against itself.

Every refresh above is read-only and best-effort: a lookup failure just
leaves that one target unresolved for the rest of the run (flagged by
`autoAttendantRowWarnings`, same as before this existed) rather than failing
the deployment - it's fixed the normal way on the next Discovery sync + a
follow-up run either way.

## Users & Common Area Phones

Planned by `apps/worker/src/planner.ts` `planIdentityRow` (users and CAPs plan
identically - only the `object_type` tag differs):
1. `revoke_ev` set -> `Remove-CsPhoneNumberAssignment -RemoveAll`, nothing else.
2. Otherwise, if a number is assigned (via the `phone_numbers` inventory in
   Design & Build) -> `Set-CsPhoneNumberAssignment -PhoneNumberType
   <CallingPlan|OperatorConnect|DirectRouting>`.
3. Then one `Grant-Cs*Policy` per target policy set in `POLICY_KINDS`
   (`packages/shared/src/domain.ts`) - voice routing, dial out, shared
   calling, dial plan, calling, call hold, call park, caller ID, voice app,
   voicemail, emergency calling, emergency call routing, IP phone. Note
   `voicemail_policy` here is a *policy grant* (tenant-defined behaviour,
   e.g. max message length) - a different thing from item 4 below.
   A target of **Global** (the tenant default) is granted as
   `-PolicyName $null` - Teams won't grant "Global" by name; `$null` removes
   the per-user assignment so the user falls back to it. Get-CsOnlineUser
   reports a user on Global as null, so a null live value counts as already
   matching (`policyMatchesLive`, shared with Validate against tenant).
4. If `voicemail.enabled` is set on the row (not null/undefined - "not
   designed yet" is left alone) -> `Set-CsOnlineVoicemailUserSettings
   -VoicemailEnabled` (+ `-PromptLanguage` when enabling with a language
   set). This is the actual per-user voicemail on/off + language setting -
   what Data Collection's `voicemail_enabled`/`voicemail_language` capture
   and Populate copies onto the row as the real deploy target, not just a
   reference.

Call forwarding, delegates and pickup groups are captured in Design & Build
(`build_users.call_forwarding`/`delegates`/`pickup_group` jsonb, matching the
workbook's CF/DEL/CPG columns) but are **not yet planned into cmdlets** - a
deliberate scope cut for this delivery. The reference cmdlets are known
(`Set-CsUserCallingSettings`, `New-CsUserCallingDelegate`) and this is the
natural next increment.

Caller ID works differently: Data Collection's `caller_id` field ('user' /
'anonymous' / 'main_number') is a customer preference, not a Teams policy
name, so there's no direct value -> cmdlet mapping - it's shown read-only in
Design & Build's "Data Collection" column so the engineer can pick or create
the matching `caller_id_policy` (a `POLICY_KINDS` entry, deployed via
`Grant-CsCallingLineIdentity` same as the others in step 3).

## Resource accounts - a genuine two-phase gate

`New-CsOnlineApplicationInstance` always needs a Phone System / Resource
Account license applied afterward by a **User or Global Administrator** - a
role a Teams Administrator (the only role Voxshift's live sign-in ever uses,
`docs/SECURITY.md`) does not have. This isn't a script limitation to work
around; it's a real permission boundary, and the reference script handles it
by always exporting the creation cmdlets to a script and pausing for the
engineer to run the licensing step manually before proceeding. Voxshift
preserves that exactly:

1. **Not yet created** (`build_resource_accounts.application_id IS NULL`):
   `planResourceAccountRow` emits one `CmdletInvocation` for
   `New-CsOnlineApplicationInstance` with `deferred: true`. A deferred call is
   **never** sent to the tenant, in either mode - it's always rendered into
   the exported script and recorded as `'whatif'`. The two well-known
   Microsoft `ApplicationId` values (`RESOURCE_ACCOUNT_APPLICATION_IDS` in
   `packages/shared/src/domain.ts`) are used directly; they're documented,
   tenant-independent constants, not secrets.
2. The engineer downloads the script (`GET
   /t/:id/deployments/:id/scripts`), runs it, and licenses the new resource
   account(s) - outside Voxshift, the same as today.
3. Back in Design & Build, the engineer ticks **"Created & licensed"** on the
   row (`PATCH .../resource-accounts/:id { created: true }`), which sets
   `application_id` to the same well-known constant - it's used purely as a
   gate flag, not a fetched object ID. There is no way to detect this live;
   it's a manual confirmation, same as the reference script's "Proceed"
   prompt.
4. On the next deployment run, `planResourceAccountRow` sees
   `application_id` set and emits the live-capable phase 2 calls:
   `Set-CsPhoneNumberAssignment` (+ `LocationId` for shared calling) and
   `Grant-CsOnlineVoiceRoutingPolicy`, if a number/policy is set on the row.
   If the account isn't actually licensed yet, the cmdlet fails and the
   executor's error message is recorded as-is on the `deployment_changes` row
   - the same error-driven signal the reference script relies on, rather than
   a separate pre-check call.

Auto Attendant / Call Queue *menu* authoring (greetings, DTMF menus, holiday
call flows) is out of scope for this delivery - resource accounts here cover
identity + number only, matching what the reference script itself automates.

## Verifying a deployment

Every live (`execute`) run checks itself once it finishes - nobody has to
remember to re-run Discovery.

1. `handleDeploymentRun` (`apps/worker/src/main.ts`) marks the run finished
   and sends its email as before, then calls `verifyDeployment`
   (`apps/worker/src/deployment-verify.ts`). Dry runs are never checked.
2. It collects every user, CAP and resource account the run touched (a change
   that was `applied` or `failed`). A run that applied nothing, or only
   changed Call Queues / Auto Attendants / Shared Calling policies, is
   recorded as **skipped** with that reason - those objects aren't re-read
   automatically; re-run Discovery to see them.
3. It takes the customer's one in-flight Discovery slot
   (`idx_tenant_discovery_runs_one_in_flight`) by inserting a
   `tenant_discovery_runs` row of kind `targeted` - the same narrow check
   Design & Build's *Validate against tenant* uses - so nothing else shares
   the PowerShell session with it. If a sync or Validate check already holds
   the slot, it doesn't wait: the verdict is **skipped** ("a Discovery run was
   already in progress") and the engineer runs Validate later.
4. It waits `DEPLOY_VERIFY_DELAY_SECONDS` (default 60 - Teams can take a
   moment to report a change it just accepted), then re-reads each account
   with `Get-CsOnlineUser -Identity` + `Get-CsOnlineVoicemailUserSettings`
   (`runTargetedUserSync`, shared with Validate), updating Discovery's stored
   snapshot and history exactly like a Validate check. At most 200 accounts
   per run (`VERIFY_MAX_ACCOUNTS`); the rest are counted as "not re-checked".
5. It re-plans those rows with the **same** `planIdentityRows` /
   `planResourceAccountRows` helpers the deployment itself used. A design that
   landed plans zero calls; every call still planned is a difference,
   described in plain English (`describeRemainingCall`,
   `packages/shared/src/deployment-verify.ts`), e.g. "Phone number: designed
   +1555..., live +1555...". An account the check couldn't find counts as
   still different. Call forwarding / call group / delegate settings are
   still left out of this verdict and counted separately (the post-deployment
   check does not read them back yet), although Discovery now reads them and the
   Deployment preview compares them.
6. The verdict is stored on `deployments.verification` (jsonb, migration
   0046; type `DeploymentVerification`): `pending` while it runs, then
   `verified` (`checked`, `matched`, `differing[]` with each row's
   differences, `notChecked`, `unverifiableSettings`, `discoveryRunId`), or
   `skipped` / `failed` with a `reason`. A Teams error during the re-check
   becomes a `failed` verdict - it never changes the deployment's own status.
   A worker restart mid-check marks a `pending` verdict failed.

The Deployment site workspace's **Run history** shows it in a Verification
column: "Verified: 48/50 match - 2 still differ", with the differing rows and
what differs underneath. Teams can lag; if a difference looks wrong, run
Validate against tenant later to re-check.

Also still available:

- `GET /t/:id/deployments/:id/changes` - the full per-cmdlet audit trail.
- `GET /t/:id/deployments/:id/scripts` - any exported `.ps1` (What-If output,
  or resource-account creation cmdlets).
- Design & Build's per-row validation badge (`docs/DATA-MODEL.md`
  `build_users.validation`) reflects Discovery's live state.

## Drift

A **drifted** row is a Design & Build row that was deployed, has not been edited since, and no longer matches Teams: someone
changed it in Teams Admin Center or PowerShell after the deployment. Rules: `packages/shared/src/drift.ts` (`classifyDrift`,
unit-tested); data: `packages/db/src/drift.ts`.

- The plan is `previewSiteChanges` (`packages/db/src/preview.ts`), the same preview Planned changes shows, now shared by the API
  and the worker. A row is drift when it plans commands, its latest live run that touched it applied something and failed
  nothing (`deployment_changes.object_id` is the build row id), `updated_at` is not after that run, and a completed Discovery
  sync finished after it. Deployed but not synced since = `awaiting_sync`. Edited since = a pending design change, not drift.
  Never deployed = a design, not drift (a row imported from Discovery and changed in Teams before it was ever deployed is not
  reported).
- A user's or common area phone's voicemail and calling-settings commands are planned whenever Discovery has not read those
  settings yet (`voicemail_enabled` / `calling_settings` null), so they are not evidence of drift (`driftEvidence`); only
  commands for settings Discovery has read count. `DriftRow.cmdlets` lists the evidence.
- **When it is worked out:** after every completed Discovery sync, for every site with a live run (the worker,
  `discovery/run.ts`), saved in `deployment_drift`; after every live deployment run for its site; and when the Drift tab opens
  (`GET /t/:id/deployments/drift?siteId=`). The Deployment sites list shows the saved count.
- **Email:** the Discovery-complete email lists the sites with drift and how many rows (same opt-out as the email itself).
- **Planned changes** marks a drifted row "changed in Teams".
- **Accept into design** (`POST /t/:id/build/drift/accept`, `build:write`): an auto attendant or call queue is refreshed from its
  discovered object (Refresh from Teams); a user or common area phone takes its live calling settings and voicemail
  (`applyLiveVoiceSettings` with `overwrite`). A number, Enterprise Voice or policy difference is not taken (numbers go through
  the number inventory): the answer lists what still differs. Resource accounts and shared calling policies: put back, or edit in
  Design & Build. Audited as `build.drift_accepted`.
- **Put back** ticks the rows on Planned changes, where the normal What-If and Deploy apply the design again.

## Rolling back

Voxshift never undoes a run by itself. For any finished live run that applied
something (completed, or failed part-way), Run history offers **Download
rollback script** (`GET /t/:id/deployments/:id/rollback-script`, audited as
`deployment.rollback_script_downloaded`): a PowerShell script for the engineer
to review and run themselves.

**Where "before" comes from.** The executor doesn't read anything back, so as
each user / CAP / resource-account cmdlet runs, the worker records in
`deployment_changes.before` what that cmdlet is about to change, taken from
the same Discovery snapshot the plan was diffed against
(`identityBeforeState`, `beforeStateResolver`): the previous LineUri +
Enterprise Voice state (and the number's type, from Discovery's phone number
inventory - needed to reassign it), the previous per-user policy (null =
Global), or the previous voicemail on/off + language (only when a Validate
check had read it). It is tagged `source: 'discovery_snapshot'`. Runs from
before this existed have empty `before` and get nothing reversed.

**What the script does** (`planRollback` / `renderRollbackScript`,
`packages/shared/src/deployment-rollback.ts`), newest change first, rendered
with `renderStatement` so values are quoted the same way as a deployment:

- New number -> reassigns the previous number with its type; if the person
  had no number, removes the new one (`-RemoveAll` when Enterprise Voice was
  also off before).
- Enterprise Voice switched on (Shared Calling) -> switches it back off.
- Revoke (`Remove-CsPhoneNumberAssignment -RemoveAll`) -> reassigns the
  previous number, or switches Enterprise Voice back on.
- `Grant-Cs*Policy` -> grants the previous policy; a previous Global is
  `-PolicyName $null` (see `isGlobalPolicyName` above).
- Voicemail -> previous on/off (+ language).
- `New-CsUserCallingDelegate` -> `Remove-CsUserCallingDelegate` (an applied
  one can only have been added by this run - the cmdlet fails on a duplicate).

**What it can't reverse** is listed in the script's header comments instead
of guessed at: anything with no recorded before-state, a previous number of
unknown type (with the command to finish by hand), emergency locations,
call forwarding / call group settings, Call Queue / Auto Attendant / Shared
Calling policy creations and changes, and resource accounts created by hand
from the exported `New-CsOnlineApplicationInstance` script. Failed commands
changed nothing and are left out. Like the exported script it stops at the
first error, and every command is safe to repeat.
