# Migration progress (home page)

The home page shows, for the active customer, where each site is in the
migration and what needs attention next. Nothing on it is entered by hand:
every stage is worked out from rows the other modules already write.

- API: `GET /t/:tenantId/progress` (`apps/api/src/modules/progress`), readable
  by every role (`tenant:read`).
- Rules: `deriveSiteProgress` in `packages/shared/src/progress.ts` - a pure
  function, unit-tested in `progress.test.ts`. The service only gathers its
  inputs; `tests/db/src/progress/progress.db.test.ts` checks those queries.
- Web: `apps/web/src/pages/Dashboard.tsx`.

## Stages

Each site has seven stages. Each is **done**, **needs attention** (reached or
tried, but something must be fixed - it comes with a blocker) or **not
started**. The site's *current* stage is the one after the furthest stage that
is done, so a site designed straight from the live tenant still shows where it
really is even if Site Data was never finished.

| Stage | Done when | Blockers (plain words) |
| --- | --- | --- |
| Site Data | the site has at least one captured user, phone (CAP) or resource account (`discovery_users` / `discovery_caps` / `discovery_resource_accounts`), and the customer's Site Data is submitted or accepted (`discovery.status`) | "No users, phones or resource accounts captured yet" - only when nothing has been designed either |
| Designed | any Design & Build row for the site (users, CAPs, resource accounts, auto attendants, call queues, shared calling policies) | - |
| Validated | designed, and `BuildService.siteRollup`'s `validationIssues` is 0 (the same count Design & Build shows) | "12 rows have validation issues" |
| Dry run | the site's latest finished dry run completed with no failures and started after the latest build-row change (max `updated_at`). A clean live run after the latest change counts too | "Last dry run failed", "Last dry run reported N failures", "Dry run is older than the latest design change" |
| Deployed | the latest finished live (execute) run completed with `summary.failed` 0 and started after the latest change | "Last live run failed", "Last live run had 3 failures", "The design has changed since the last live run" |
| Handover | an **issued** handover pack covers the site (its `source.siteIds` is empty = every site, or lists the site) and was issued after the site's first clean live run | - (a draft or an early pack shows as the stage's detail) |
| Operations | `discovery_sites.mode = 'operations'` | - |

"Finished" runs are `completed` or `failed`; a queued or running run only shows
as "in progress" on its stage. Deleting a build row doesn't change any
`updated_at`, so a deletion alone doesn't make a dry run look stale.

## Customer-level items

Shown above the sites ("Needs attention" when they need action, otherwise as a
status line):

- Site Data status - not submitted yet (attention), submitted and waiting
  for review (attention for roles with `discovery:review`).
- Last Discovery sync of the live tenant (roles with `tenantdiscovery:read`) -
  the latest `tenant_discovery_runs` row of kind `sync`, the same run the
  Discovery page shows. Never synced or failed = attention.
- Open service requests, when Managed Services is on and the role has `sr:read`.
  New, unplanned requests are attention for roles with `sr:manage`.

## Who sees what

- **Engineers and super admins** see every stage, every blocker, and links to
  the site's page in each module (`/data-collection/sites/:id`,
  `/build/sites/:id`, `/deployment/sites/:id`, `/handover`, `/service-requests`).
- **Project managers and customers** have no Design & Build or Deployment
  access, so Designed / Validated / Dry run / Deployed collapse into one
  **Design & deployment** stage (done once the site is live) with no
  engineering blockers and no links.
- **Site contacts** (customer users limited to some sites) see only their
  sites, and the Handover stage isn't linked (packs are customer-wide).
