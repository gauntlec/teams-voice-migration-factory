# Managed Services — service requests

Once a customer's migration is live, Managed Services lets that customer ask for
changes through Voxshift instead of by email: new users, phone numbers, sites,
common area phones, call queues and auto attendants (plus "something else").
The engineers and admins on the customer work each request through to live.

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
 └────────┴──────────────┴──▶ Cancelled
```

- Requests move **one step at a time**; a step can't be skipped and a request
  can't go back. Any open request (New, Planned, Designed & built) can be cancelled.
- Engineers and admins (`sr:manage`) move requests on, assign them, and can add
  **internal notes** that the customer never sees. Each move can carry a note,
  which is included in the email to the requester.
- The person who raised a request can cancel it **while it is still New**.
- Requests for a **user, common area phone, call queue or auto attendant** are
  designed and deployed **inside the request** (its Design and Deploy tabs, below).
  A new site is created from the request into Data Collection; new numbers and
  "something else" are done by hand and moved on with the status buttons.
- **Designed & built** needs at least one row designed for the request (and none
  deleted since). A **Deploy** from the request with no failed changes moves it to
  **Deployed** by itself and emails the requester. An engineer can still mark it
  deployed by hand if it went live some other way.
- Every event (raised, moved, assigned, comment, rows created in Design & Build,
  deployment runs) is on the request's timeline and in the tenant audit log.

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
| `sr:manage` | Plan / build / deploy / cancel, assign, internal notes, Create in Design & Build | SUPER_ADMIN, ENGINEER |

The Design tab also needs `build:read` (and `build:write` to change anything); Deploy needs `deployment:dryrun` for What-If and `deployment:execute` for a live deploy.

A **site contact** (customer user pinned to certain sites) only sees requests for
their own sites, can only raise requests for those sites, and can't ask for a new
site (that's a customer-wide request).

Requests are assigned to people who can action them: the **engineers who are
members of that customer** and **Super Admins**.

## Emails

| When | Template | To |
|---|---|---|
| A request is raised | `service_request_created` | The customer's engineers (members with the ENGINEER role) and every active Super Admin, except whoever raised it |
| A request reaches Planned, Designed & built, Deployed or Cancelled | `service_request_status_changed` | The person who raised it, unless they made the change themselves |

Both use the customer's branding and link straight to the request
(`/service-requests/:id`). The Deployed email is also sent when a deployment
from the request moves it on (by the worker, same template).

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
| New phone numbers | Yes | Quantity (1–1000), purpose, existing range to extend, number type |
| New common area phone | Yes | Phone name, location, device model (menu), phone number |
| New call queue | Yes | Name, agents (directory), call sharing, wait time, where unanswered calls go, phone number |
| New auto attendant | Yes | Name, greeting, menu options (key → where), opening hours, out of hours (where), phone number |
| Something else | Optional | Description |

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
  (`site`/`user`/`cap`/`resource_account`/`shared_calling_policy`/`call_queue`/`auto_attendant`),
  `row_id` (a plain reference into the table `kind` names), `created_by`
  (`0038_sr_design_items.sql`).

API: `apps/api/src/modules/service-requests/` — `GET/POST /t/:tenantId/service-requests`,
`GET :id`, `POST :id/status`, `POST :id/assign`, `POST :id/comments`,
`POST :id/build-draft`, `GET :id/design`, `DELETE :id/items/:kind/:rowId`,
`GET :id/deploy-preview`, `POST :id/deploy` (`{ connectionId, mode }`), `GET :id/runs`,
`GET assignees`. Design & Build lists take `serviceRequestId` to list one request's rows.
Shared rules: `packages/shared/src/service-request-design.ts`.
Web: `apps/web/src/pages/ServiceRequests.tsx` (list, new request),
`ServiceRequestPage.tsx` (one request), `BuildSiteWorkspace.tsx` (`embedded`).

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
- The queue is for triage. A request is opened (and actioned) inside its
  customer, so a request for a customer you're not on the team for is listed
  but can't be opened.
