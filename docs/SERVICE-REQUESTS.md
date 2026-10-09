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
- The design and build itself happens in **Design & Build**, and the change goes
  live through **Deployment**, as for any other change. The request records the
  progress and keeps the customer informed.
- Every event (raised, moved, assigned, comment) is on the request's timeline
  and in the tenant audit log.

## Who can do what

| Permission | Meaning | Roles |
|---|---|---|
| `sr:read` | See this customer's requests | SUPER_ADMIN, PROJECT_MANAGER, ENGINEER, CUSTOMER |
| `sr:create` | Raise a request; comment; cancel your own New request | SUPER_ADMIN, PROJECT_MANAGER, ENGINEER, CUSTOMER |
| `sr:manage` | Plan / build / deploy / cancel, assign, internal notes | SUPER_ADMIN, ENGINEER |

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
(`/service-requests?id=…`).

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
  (`created`/`status_changed`/`assigned`/`comment`), from/to status, body,
  `internal`, author.

API: `apps/api/src/modules/service-requests/` — `GET/POST /t/:tenantId/service-requests`,
`GET :id`, `POST :id/status`, `POST :id/assign`, `POST :id/comments`, `GET assignees`.
Web: `apps/web/src/pages/ServiceRequests.tsx`.

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
