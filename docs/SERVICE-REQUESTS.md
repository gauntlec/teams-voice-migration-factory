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

## Request types and their fields

Each type's form is defined once, in `SR_TYPE_DEFS`
(`packages/shared/src/service-requests.ts`). The web form renders from those
specs and the API builds its validation from the same specs (`srDetailsSchema` in
`dto.ts`), so adding or changing a field is a one-place change.

| Type | Needs a site | Key fields |
|---|---|---|
| New site | No | Site code, name, address, country, wanted-by date, site contact |
| New user | Yes | Name, sign-in address (UPN), phone number need, voicemail |
| New phone numbers | Yes | Quantity (1–1000), purpose, area, number type |
| New common area phone | Yes | Phone name, location, device model, phone number need |
| New call queue | Yes | Name, agents (one per line), call sharing, unanswered behaviour, phone number need |
| New auto attendant | Yes | Name, greeting, menu options, opening hours, out of hours, phone number need |
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
