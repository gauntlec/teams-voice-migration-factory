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
   voicemail, emergency calling, emergency call routing, IP phone.

Voicemail settings, call forwarding, delegates and pickup groups are captured
in Design & Build (`build_users.voicemail`/`call_forwarding`/`delegates`/
`pickup_group` jsonb, matching the workbook's VM/CF/DEL/CPG columns) but are
**not yet planned into cmdlets** - a deliberate scope cut for this delivery,
matching the approved plan. The reference cmdlets are known
(`Set-CsOnlineVoicemailUserSettings`, `Set-CsUserCallingSettings`,
`New-CsUserCallingDelegate`) and this is the natural next increment.

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

- `GET /t/:id/deployments/:id/changes` - the full per-cmdlet audit trail.
- `GET /t/:id/deployments/:id/scripts` - any exported `.ps1` (What-If output,
  or resource-account creation cmdlets).
- Design & Build's per-row validation badge (`docs/DATA-MODEL.md`
  `build_users.validation`) reflects Discovery's live state, so re-running
  Discovery after a deployment and reopening the site shows whether the
  target configuration actually landed.
