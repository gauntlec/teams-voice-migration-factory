# Managed Services — service requests

Once a customer's migration is live, Managed Services lets that customer ask for
changes through Voxshift instead of by email. They can ask for new things (users,
several new starters at once, phone numbers, sites, common area phones, call
queues, auto attendants), changes to existing ones (a user's number, forwarding,
voicemail or permissions; a call queue's people and routing; an auto attendant's
hours, holidays, menu or greeting), removals (a leaver, a common area phone),
or "something else". The engineers and admins on the customer work each request
through to live, against response and resolution targets.

## Switching it on

Managed Services is **off** for every customer by default. A Super Admin turns it
on per customer from **Administration → Customers → Managed Services**
(`PATCH /tenants/:tenantId/managed-services`, needs `tenant:update`;
`platform.tenants.managed_services_enabled`). While it is off, the **Service
Requests** page is hidden from the left nav and every service-request endpoint
returns 403. Turning it off later keeps existing requests.

## Site modes: project and operations

Every site is in **project** mode while it is being migrated and moves to
**operations** mode once it is live (`discovery_sites.mode`, migration
`0036_site_mode.sql`). Service requests can only be raised for sites in
operations mode; a site in project mode is shown but can't be picked.
Requests with no site (a new site, or "something else") are always allowed.

Engineers and admins (`sr:manage`) change a site's mode from **Service Requests →
Site modes** (`PATCH /t/:tenantId/service-requests/sites/:siteId/mode`). This
is separate from editing the site in Sites, so it still works once Data
Collection is locked. Each change is audited with who and when.

## Workflow

```
New ──▶ Planned ──▶ Designed & built ──▶ Deployed
 │         ▲   ◀── send back ──┘            │
 │         └──────── reopen (14 days) ──────┘
 └─ any open status ──▶ Cancelled / Declined
```

- Requests move **one step forward at a time**. The team can also **send back**
  Designed & built → Planned (e.g. the design was wrong or a deploy failed) and
  **decline** an open request; the person who raised it, or the team, can
  **reopen** a Deployed request within 14 days (`SR_REOPEN_DAYS`). Declining,
  sending back and reopening need a reason. See `srMoveKind` in
  `packages/shared/src/service-requests.ts`.
- The person who raised a request can cancel it **while it is still New**.
- Customers see plain status names: Received, Scheduled, Ready to go live,
  Completed, Cancelled, Declined (`SR_STATUS_CUSTOMER_LABELS`); the team sees
  New, Planned, Designed & built, Deployed.
- Requests that change Design & Build (new, change and remove for users, common
  area phones, call queues and auto attendants, and several new users) are
  designed and deployed **inside the request** (Design and Deploy tabs, below).
  New phone numbers are designed by adding the range to the site's inventory. A
  new site is created from the request (and goes straight into operations
  mode). "Something else" is done by hand.
- **Designed & built** needs the design done: at least one row linked (and none
  deleted since), or for new numbers, at least one range added. A **Deploy**
  from the request with no failed changes moves it to **Deployed** by itself and
  emails the requester. An engineer can still mark it deployed by hand.
- A request whose type the customer wants **approved** can't be planned until
  one of their approvers approves it (see Approval).
- Every event (raised, moved, assigned, comment, question, approval, attachment,
  rows designed, deployment runs) is on the request's timeline and in the
  tenant audit log.

## Conversation

- **The team replies** on the request: the requester is emailed
  (`service_request_message`, kind `comment`).
- **Ask and wait**: the team asks a question and the request is flagged
  **Waiting on customer** (`waiting_since`). The requester is emailed (kind
  `question`) and reminded every 3 days, at most 3 times (worker sweep, kind
  `reminder`). The clock for targets stops while waiting. The customer's reply
  ends the wait (and tells the team); the team can also **Stop waiting**, and
  any status move ends it.
- **The customer comments**: the assignee is emailed, or every engineer and
  Super Admin on the customer when nobody is assigned (`service_request_activity`,
  kind `comment` or `replied`).
- **Internal notes** never reach the customer; the assignee is emailed.
- **Assigning** a request emails the new assignee.
- **Attachments**: anyone who can see a request can attach pictures, PDFs,
  Office documents, CSV and text files (10 MB each), stored in the tenant file
  store (category `service_request_attachment`) and downloaded through the
  request (`GET :id/attachments/:fileId`), never the general file browser.

## The request page

Each request opens on its own page, `/service-requests/:id` (old `?id=` links
redirect). Everyone sees **Overview**: the details, progress, the "move this
request on" buttons and the timeline. Engineers and Super Admins also get
**Design** and **Deploy** on user, common area phone, call queue and auto
attendant requests that have a site. Customers never see those tabs.

### Design

The Design tab embeds the **same editors as Design & Build** (the record forms,
the calling settings, the call queue and auto attendant configuration dialogs,
shared calling), opened on the request's site and on the tab that matches the
request, but **listing only the rows designed for this request**.

- It's editable while the request is **Planned**; read-only before (mark it
  Planned to start) and after (Designed & built, Deployed, Cancelled).
- **Prefill** creates the request's main row from the customer's answers (see
  "Create from the request" below), then the engineer finishes it in the
  editors: number, policies, routing, menus.
- Anything **added** on the Design tab (a user, phone, resource account, call
  queue, auto attendant or shared calling policy) is **linked to the request**:
  the browser sends `x-service-request: <id>` on Design & Build create calls,
  and `ServiceRequestLinkInterceptor` (on the Design & Build controller) links
  the new row in `service_request_items`. It refuses, before anything is made,
  unless Managed Services is on, the caller has `sr:manage`, the request is
  Planned and the row is on the request's site.
- Site-wide tools (Populate from Discovery, Reset site, bulk edit, templates,
  resource account requests) stay on the site's own Design & Build page.
- Linked rows are **ordinary Design & Build rows**: they also show on the site's
  Design & Build page, tagged with the request reference (e.g. `SR-0042`).
- **Remove from request** takes a row off the request without deleting it. A
  row deleted in Design & Build shows as "Deleted" and blocks Designed & built
  until it is removed from the request.
- **Rows lock once the request is past design.** While a linked request is
  **Designed & built** (any open request that isn't Planned), the API
  refuses to change or delete its rows from anywhere - the Design tab, the
  site's Design & Build page, bulk edit, templates, Reset site, "Apply the
  request" on another request, or a direct call - with a 409 such as
  "SR-0003 is Designed & built - send it back to Planned to change its
  design." What gets deployed is then what was signed off. The rule is
  `srDesignLocksRows` (`service-request-design.ts`); the check is
  `BuildService.assertNotSrLocked`, run before any side effect.
  - **No Super Admin override.** Sending the request back to Planned (with a
    reason, on its timeline) is the way to change it, for everyone.
  - **Finished requests release their rows.** Deployed, Cancelled and
    Declined don't lock, or a row could never change after go-live: a later
    change request links and edits the same row. Reopening a Deployed request
    puts it back to Planned, which is editable anyway.
  - Number ranges (new phone numbers requests) aren't Design & Build rows and
    aren't covered by this lock.

### Change and remove requests

"Prefill" becomes **Apply the request** (`service-request-change.ts`): it finds
the existing Design & Build row (a user who isn't in Design & Build yet is added
to the request's site; one on another site is refused), links it to the request
and applies what maps cleanly through the normal update path:

| Request | Applied automatically | Left as a to-do |
|---|---|---|
| Change a user | new number (if still free), voicemail on/off | forwarding, calling permissions, "something else" |
| Remove a user / common area phone | Revoke Enterprise Voice (deploys `Remove-CsPhoneNumberAssignment -RemoveAll`) | clearing the number afterwards if it's to be reused |
| Change a call queue | agents added / removed, routing method | timeout / overflow |
| Change an auto attendant | new greeting, a holiday closure (play the message, then end the call) | opening hours, menu |

The to-do list is shown on the Design tab and recorded on the timeline.

### Several new users

When "New number" is chosen, one free number per person is set aside when the
request is raised (`details.new_numbers`, `{ upn: e164 }`; refused if the site
hasn't enough). Prefill makes one Design & Build user per person, each with
their number (and voicemail), and links them all. A single new user's picked
number is also put on the row now, if it's still free.

### New phone numbers

The Design tab asks for the carrier's range (first / last number, carrier).
`POST :id/numbers` adds it to the site's inventory as free numbers (not blocked
by a locked Data Collection) and links it to the request (`number_range` item).
There's nothing to deploy.

### Deploy

What-If and Deploy for **just this request's rows** on the engineer's own
tenant connection, through the normal deployment path (read-only tenants,
number mismatches and one live run per connection are all still enforced).
The scope is the linked rows on the site, plus the resource accounts its call
queues and auto attendants answer on, plus (as for any deployment) users a queue
or attendant routes to.

- **What-If** while Planned or Designed & built; **Deploy** (needs
  `deployment:execute`) once Designed & built, after a confirmation.
- The run is stored with `scope.serviceRequestId`. When it finishes, the
  worker adds a staff-only "deployment" entry to the timeline. A **live run with
  no failed changes** on a Designed & built request moves it to **Deployed** and
  emails the requester (`apps/worker/src/service-requests.ts`).
- The tab lists the request's runs and each run's changes.
- **Change window**: if the customer has one (Settings), a live deploy outside it
  asks for a reason, which is noted on the request (the API refuses without
  one). What-If is never restricted.
- A read-only tenant is shown up front and Deploy is disabled.

## Targets (SLAs)

Per customer, per priority, in **calendar hours** (`service-request-sla.ts`):

| Priority | First response | Completed |
|---|---|---|
| Urgent | 1h | 8h |
| High | 4h | 24h |
| Normal | 8h | 72h |
| Low | 24h | 120h |

These are the defaults; a Super Admin changes them in **Service Requests →
Settings** (`platform.tenants.sr_settings.targets`). First response is the
team's first reply, question or move; completed is Deployed (or Declined).
Time waiting on the customer is left out, and a reopen restarts the completion
clock. Each request shows where it stands (Due in…, At risk, Overdue, Paused,
Met, Missed): staff see it in the list and both see it on the request. The
worker emails the team once when a target is at risk (20% left) and once when
it's missed (`sla_notified`).

## Approval

In Settings a Super Admin picks request types that need approval and the
customer users who can approve. Such a request is raised **awaiting approval**
and the approvers are emailed; the team can't plan it until one approves.
Rejecting declines it, with the reason, and tells the requester and the team.
An approver's own request is approved straight away.

## Checks when raising

The form shows non-blocking warnings as it's filled in (`POST check`), and the
team sees the same on the request: the person isn't in the synced directory,
has no Teams Phone licence (`PhoneSystem` feature or an enabled `MCOEV` plan),
already has calling (new user) or has none to remove (leaver), is already in
Design & Build, or another open request covers the same person, queue, auto
attendant or phone.

## Reporting and queue summary

- **Reports** (Service Requests page, everyone): one month at a time - raised,
  completed, median time to complete (less waiting), first response and
  completion on time, by type, and today's open backlog by age
  (`GET report?from=&to=`).
- **Summary tiles** (staff): Open, Unassigned, Waiting on customer, At risk,
  Overdue - click to filter. Also on the MSP queue.

## Create from the request

So the engineer doesn't retype what the customer already entered, a request
that is **New** or **Planned** can create its main row from the request's
answers (**Prefill** on the Design tab; **Create the site** on a new-site
request's Overview). It is linked to the request:

| Request | Creates | From the request |
|---|---|---|
| New user | Users row (`build_users`) | UPN; name, phone number need and notes go in Comments; voicemail on/off |
| New common area phone | Common area phones row (`build_caps`) | Display name, location, model; number need and notes in Comments. The engineer enters the account UPN (suggested from the name and the customer's main domain) |
| New call queue | Call queues row (`build_call_queues`) | Name, agents, routing method; "if nobody answers" and notes in Notes |
| New auto attendant | Auto attendants row (`build_auto_attendants`) | Name; the greeting as a text-to-speech prompt; opening hours and out-of-hours as the narrative fields; menu and notes in Notes |
| New site | A new site (`discovery_sites`) | Site code, name, address, country |
| New phone numbers, Something else | Nothing - the button isn't shown | |

- **The phone number is always left for the engineer** to pick in Design & Build.
- **Agents** typed as names rather than sign-in addresses are looked up in the
  synced directory (then Data Collection's users); a name that matches exactly
  one person becomes their UPN. Anyone not found is listed as a warning.
  How calls are shared out maps to the routing method: All at once ->
  `Attendant`, In order -> `Serial`, Round robin -> `RoundRobin`, Longest idle ->
  `LongestIdle` (`SR_ROUTING_TO_BUILD`).
- Long answers are shortened to the Design & Build field limits, ending
  "… (full text on SR-0042)". Every row's comments/notes start "From SR-0042."
- The row goes through the **same validation and create path as adding it by
  hand**. A UPN Design & Build wouldn't accept is refused with the reason.
- **Nothing is ever overwritten.** If a row with the same natural key already
  exists anywhere on the customer (UPN for users/CAPs, name for call queues and
  auto attendants, site code for sites; all case-insensitive) it's reported as
  "already in Design & Build" with a link, and left as it is. Pressing the
  button twice is safe.
- A new site is added even when the customer's Data Collection is accepted and
  locked: a site added after go-live is an operational change
  (`DataCollectionService.insertSite`).
- The request's **status doesn't change**. Mark it Designed & built once the row
  is finished. An existing row it finds is linked to the request as it is.
- A staff-only timeline entry ("Created draft rows in Design & Build: …") links
  to the rows, which open on the right Design & Build tab
  (`/build/sites/:siteId?tab=…`) or the new site's page.

The mapping is in `packages/shared/src/service-request-build.ts` (pure, unit
tested in `service-request-build.test.ts`); the endpoint is
`POST /t/:tenantId/service-requests/:id/build-draft` (`sr:manage`; body
`{ capUpn? }`), in `ServiceRequestsService.draftInBuild`. It also needs
`build:write` (or `discovery:sites:manage` for a site), and is refused for
Designed & built, Deployed and Cancelled requests.

## Who can do what

| Permission | Meaning | Roles |
|---|---|---|
| `sr:read` | See this customer's requests | SUPER_ADMIN, PROJECT_MANAGER, ENGINEER, CUSTOMER |
| `sr:create` | Raise a request; comment; cancel your own New request | SUPER_ADMIN, PROJECT_MANAGER, ENGINEER, CUSTOMER |
| `sr:manage` | Plan / build / deploy / cancel, decline, send back, assign, internal notes, ask and wait, design | SUPER_ADMIN, ENGINEER |

Settings (targets, approvals, change window) can only be changed by a Super
Admin; everyone on the customer can read them ("Our targets"). Approving is for
the customer users named as approvers.

The Design tab also needs `build:read` (and `build:write` to change anything); Deploy needs `deployment:dryrun` for What-If and `deployment:execute` for a live deploy.

A **site contact** (customer user pinned to certain sites) only sees requests for
their own sites, can only raise requests for those sites, and can't ask for a new
site (that's a customer-wide request).

Requests are assigned to people who can action them: the **engineers who are
members of that customer** and **Super Admins**.

## Emails

| When | Template | To |
|---|---|---|
| A request is raised | `service_request_created` | The customer's engineers and every active Super Admin, except whoever raised it |
| It needs approval | `service_request_activity` (`approval_needed`) | The customer's approvers |
| It moves on, is declined, cancelled or reopened (not sent back) | `service_request_status_changed` | The person who raised it, unless they did it |
| The team replies, asks, or the question is still unanswered | `service_request_message` (`comment` / `question` / `reminder`) | The person who raised it |
| The customer comments, replies, reopens or cancels; it's approved or rejected | `service_request_activity` | The assignee, or the whole team when nobody is assigned |
| An internal note; it's assigned to you | `service_request_activity` (`internal_note` / `assigned`) | The assignee |
| A target is at risk or missed | `service_request_activity` (`sla_warning` / `sla_breached`) | The assignee, or the whole team |

All use the customer's branding and link to the request (`/service-requests/:id`).

## Picking from existing data

The request form avoids free text wherever Voxshift already has the data
(`GET /t/:tenantId/service-requests/options?siteId=` and `/people?q=`):

- **People** (new user, site contact, call queue agents, "a person" as a call
  target) are searched in the customer's directory: the synced Teams users,
  then Data Collection users not synced yet. "Not listed?" allows typing a
  person who isn't in either.
- **New number**: when "New number" is chosen and a site is picked, the first
  free number at that site is picked automatically and can be changed. Free
  means `available` in the site's ranges and not already taken by another open
  request; cancelling a request frees its number. If the site has no free
  numbers the form says so.
- **Number to keep**: any of the site's numbers.
- **Where calls go** (call queue overflow, auto attendant menu options and out
  of hours): a call queue or auto attendant at the site, a person, voicemail,
  or disconnect.
- **Range** (new numbers), **device model** (common area phones, from the
  models already recorded) and **country** (new sites) are menus.

Free text is kept only where there is nothing to pick from: names, addresses,
greetings, opening hours and notes.

The API checks the same things, so a hand-crafted request can't get around
them: the site must be in operations mode, the new number must be free at the
site and not taken (requests taking a number are serialised, so two can't take
the same one), a number to keep must be one of the site's, a new site code must
be unused, and any call queue or auto attendant chosen must be at the site.

## Request types and their fields

Each type's form is defined once, in `SR_TYPE_DEFS`
(`packages/shared/src/service-requests.ts`). The web form renders from those
specs and the API builds its validation from the same specs (`srDetailsSchema` in
`dto.ts`), so adding or changing a field is a one-place change.

| Type | Needs a site | Key fields |
|---|---|---|
| New site | No | Site code, name, address, country (menu), wanted-by date, site contact (directory) |
| New user | Yes | Person (directory), phone number (new = auto-picked free number, or keep one of the site's), voicemail |
| Several new users | Yes | People (directory, up to 50), new number for each or none, voicemail |
| New phone numbers | Yes | Quantity (1–1000), purpose, existing range to extend, number type |
| New common area phone | Yes | Phone name, location, device model (menu), phone number |
| New call queue | Yes | Name, agents (directory), call sharing, wait time, where unanswered calls go, phone number |
| New auto attendant | Yes | Name, greeting, menu options (key → where), opening hours, out of hours (where), phone number |
| Change a user | Yes | Person, what should change (number, forwarding, voicemail, permissions, other) and the matching answers, when |
| Change a call queue | Yes | The queue (from the site), people to add / remove, routing, when nobody answers |
| Change an auto attendant | Yes | The auto attendant, opening hours, holiday closure (name, dates, message), menu, greeting |
| Remove a user | Yes | Person, last working day, release or keep their number |
| Remove a common area phone | Yes | The phone (from the site), release or keep its number |
| Something else | Optional | Description |

Field kinds include `choices` (tick boxes - "what should change") and
`site_object` (an existing queue / auto attendant / phone at the site). A field
can depend on a tick (`showWhen`), and anything depending on a hidden field is
hidden too.

## Data

Tenant schema (`0035_service_requests.sql`):

- `service_requests` — `number` (per-customer sequence, shown as `SR-0001`),
  `type`, `title`, `site_id`, `details` jsonb (the form answers), `priority`,
  `status`, `target_date`, `requested_by`, `assigned_to`, and when each stage was
  reached (`planned_at`, `built_at`, `deployed_at`, `cancelled_at`).
- `service_request_events` — the timeline: `kind`
  (`created`/`status_changed`/`assigned`/`comment`/`build_drafted`), from/to
  status, body, `internal`, author, and `links` (`build_drafted` only: the rows
  created, `[{ kind, label, href }]`; `0037_sr_build_drafted_event.sql`), and
  `deployment_id` (`deployment` entries: the run).
- `service_request_items` — rows designed for a request: `request_id`, `kind`
  (`site`/`user`/`cap`/`resource_account`/`shared_calling_policy`/`call_queue`/`auto_attendant`/`number_range`),
  `row_id` (a plain reference into the table `kind` names), `created_by`
  (`0038_sr_design_items.sql`).
- `0039_sr_conversation_workflow.sql`: `declined` status, `declined_at`,
  `reopened_at`, waiting on customer (`waiting_since`, `waiting_seconds`,
  `waiting_reminded_at`, `waiting_reminders`), `first_response_at`, and the
  `waiting` / `resumed` timeline kinds.
- `0040_sr_change_remove_types.sql`: the change and remove types.
- `0041_sr_sla_notified.sql`: `sla_notified` (target emails sent).
- `0042_sr_phase4.sql`: `new_users`, approval (`approval_status`, `_by`, `_at`,
  `_note`), `number_range` items, `approval` / `attachment` timeline kinds, the
  `service_request_attachment` file category.
- Platform `0014_tenant_sr_settings.sql`: `tenants.sr_settings` (targets,
  approval, change window).

API: `apps/api/src/modules/service-requests/` — `GET/POST /t/:tenantId/service-requests`,
`GET :id`, `POST :id/status`, `POST :id/assign`, `POST :id/comments`,
`POST :id/build-draft`, `GET :id/design`, `DELETE :id/items/:kind/:rowId`,
`GET :id/deploy-preview`, `POST :id/deploy` (`{ connectionId, mode, outsideWindowReason? }`), `GET :id/runs`,
`POST :id/resume`, `POST :id/approval`, `POST :id/numbers`, `GET/POST :id/attachments`,
`GET :id/attachments/:fileId`, `GET/PUT settings`, `GET report`, `POST check`,
`GET customer-users`, `GET assignees`. Design & Build lists take `serviceRequestId`
to list one request's rows.
Shared rules: `packages/shared/src/service-request-design.ts`, `service-request-change.ts`,
`service-request-sla.ts`. Worker: `apps/worker/src/service-requests.ts` (run results,
reminders, target emails, every 15 minutes).
Web: `apps/web/src/pages/ServiceRequests.tsx` (list, new request),
`ServiceRequestPage.tsx` (one request), `ServiceRequestAdmin.tsx` (settings, reports),
`components/SrTarget.tsx`, `BuildSiteWorkspace.tsx` (`embedded`).

## MSP service-request admin

**MSP → Service request admin** (`/msp/service-requests`, permission `sr:msp`)
is one queue across every customer an MSP looks after.

- A customer's MSP is set by a Super Admin on **Customers → MSP**
  (`platform.tenants.msp_id`, migration `0013_tenant_msp.sql`).
- Engineers and project managers see the customers of their own MSP, worked
  out the same way as app branding (email domain, then the per-user override).
  Staff not linked to an MSP see an empty queue with an explanation.
- Super Admins see every customer and can filter by MSP (or "No MSP").
- Only customers with Managed Services switched on are included.
- Each item shows its target status; the most urgent come first. Summary tiles
  and **Assigned to me** filter the queue.
- For customers you're on the team for, **Assign / reply** works from the queue
  itself (assign, reply, ask and wait, internal note:
  `msp/service-requests/:tenantId/:id/assign|comments`). Anything else is done
  inside the customer; a request for a customer you're not on is listed but
  can't be opened.
