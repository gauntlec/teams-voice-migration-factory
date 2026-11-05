# Voxshift Insights (dashboard and reports)

Insights is the plan to give executives a home page and reports worth looking at. It has three parts:

- **one set of figures** for a customer;
- an **Overview** home page;
- a **Reports** area that exports and emails the same figures.

Because the Overview and Reports read the same figures, they never disagree.

The proposal, mock-ups and plan were agreed on 5 November 2026. The five steps are:

| Step | What | State |
| --- | --- | --- |
| 1 | Foundation: shared figures, daily snapshots, site go-live dates | **Built** (this page) |
| 2 | Customer Overview home page (today's list moves to a My work tab) | Planned |
| 3 | Reports area: catalogue, periods, comparison, Excel and CSV | Planned |
| 4 | Executive summary PDF and scheduled emails | Planned |
| 5 | All-customers view, Portfolio report, Present mode | Planned |

The charts in steps 2 to 5 use Fluent UI's chart library (`@fluentui/react-charts`), so they follow the app theme and dark
mode. The library is added in step 2, with the first chart, rather than shipped unused in step 1.

## The figures

`GET /t/:tenantId/insights/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`

- The `to` date is included in the period.
- With no dates, the period is the 30 days up to today.
- A period can be at most 400 days.
- Every role on the customer can read the figures (`tenant:read`). What each role sees is cut down in
  `InsightsService.metrics` (`apps/api/src/modules/insights`).
- The types are in `packages/shared/src/insights.ts` (`CustomerMetrics`).

| Part | What it holds | Source |
| --- | --- | --- |
| `migration` | sites, sites live and in service, sites by stage, users and numbers in scope and live, port requests, next go-live, programme end, overall status, and one row per site | the home-page progress rules (`ProgressService`, `deriveSiteProgress`), `build_users` / `discovery_users`, `phone_numbers`, `number_port_requests`, `discovery_sites.target_go_live` |
| `changes` | changes applied, failed and skipped in the customer's Teams tenant by live runs in the period, and the first-time success rate | `deployment_changes` joined to `deployments` (mode `execute`) |
| `incidents` | raised, resolved, open (P1, P2), response and restoration targets met, median time to acknowledge and restore | `IncidentReportService.report`, plus a count of open incidents by priority |
| `serviceRequests` | raised, completed (by an assistant), open, median time to complete, completion targets met | `ServiceRequestsService.report` |
| `devices` | devices monitored and down now, and the mean 24-hour availability | Monitoring (`deviceStatusOverview`) |

**How the figures are counted**

- **A site is live** once its Deployed stage is done (a clean live run after the latest design change) or it is in service.
- **A site's users** are its Design & Build users. Until anything is designed, its Site Data users count instead.
- **A site's numbers** are the numbers in its number ranges. Users and numbers are **live** when their site is live.

**What each role sees**

- **Stages:** people who can't open Design & Build or Deployment (project managers, customers) see Designed, Validated,
  Dry run and Deployed as one stage, "Design & deployment" (`delivery`), as on today's home page. The go-live status is
  still worked out from the full stages.
- **Optional parts:** `incidents` and `serviceRequests` appear only when Managed Services is on and the role can read them.
  `devices` appears only when Monitoring is on for the customer, set up, and readable by the role.
- **Site contacts** see only their own sites. That covers the site rows, the changes made by their sites' runs, their sites'
  devices and their sites' incidents.

## Go-live dates

Each site has an optional **target go-live date**.

- **Who sets it:** project managers, engineers and admins (`discovery:sites:manage`), in **Site Data > (the site)**, next to
  the number summary.
- **Who sees it:** anyone who can open the site.
- **Routes:**
  - `GET /t/:tenantId/insights/sites/:siteId/go-live`
  - `PUT /t/:tenantId/insights/sites/:siteId/go-live`, with body `{ targetGoLive: 'YYYY-MM-DD' | null, reason? }`
- **First agreed date:** the first date given is kept as `first_go_live`, so a moved date can show what was agreed.
  Clearing the date clears both.
- **Audit:** every change is recorded in the customer's audit log as `discovery.site_go_live_set`, with the old date, the
  new date and the reason.
- **Not Site Data:** setting the date is a project decision. It does not change the site's review status and is not
  listed as a change since submission.

### Go-live status

`siteGoLiveStatus` in `packages/shared/src/insights.ts` (unit-tested in `insights.test.ts`):

| Status | When |
| --- | --- |
| Live | the site is live, whatever its date |
| No go-live date | no target date is set |
| Off track | the target date has passed and the site is not live |
| At risk | Site Data is not finished and go-live is 30 days away or less |
| At risk | the site has something to fix (a home-page blocker) and go-live is 14 days away or less |
| At risk | there is no clean dry run yet and go-live is 14 days away or less |
| On track | otherwise |

The rules are checked in that order, and the first that applies gives the status and its plain-words reason. The day
counts are `GO_LIVE_RISK_DAYS`.

The customer's overall status works like this:

- **All sites live** once every site is live.
- Otherwise, the worst status among its sites that are not yet live, in the order **Off track**, **At risk**,
  **On track**.
- **No go-live dates** when none of those sites has a date.

## Daily snapshots

Trends need history, and the home-page progress is worked out live. So the api keeps one snapshot of each active
customer's figures per UTC day, in the customer's `metric_snapshots` table (tenant migration `0084`).

- **When:** `InsightsSnapshotService` checks every `INSIGHTS_SNAPSHOT_INTERVAL_SECONDS` (default 3600; `0` switches it off)
  and two minutes after the api starts.
- **Once a day:** a customer that already has today's row is skipped, so a restart or a second api instance never takes
  two. A customer whose snapshot failed is tried again at the next check.
- **What is kept:** each site's stage, whether it is live or in service, its users, numbers, go-live status and date,
  plus the customer's open incidents (P1, P2), open service requests and devices down (`MetricSnapshot`).
- **How long:** rows older than two years (`MAX_SNAPSHOT_DAYS`) are removed.
- **Reading it back:** `GET /t/:tenantId/insights/history?from=&to=` returns one point per day, defaulting to the last
  90 days.
  - Each point adds up the sites.
  - For a site contact, a point adds up only their sites and leaves out the customer-wide incident, request and device
    counts.

History starts on the day this ships, so the first trend lines in step 2 will be short.

## Tests

- `packages/shared/src/insights.test.ts`: the go-live rules, the customer status, periods and snapshot totals.
- `tests/db/src/insights/insights.db.test.ts`: the queries behind the figures, go-live dates (first date kept, audit,
  Site Data review untouched, site scope), what each role sees, one snapshot a day, history, and removing old snapshots.
