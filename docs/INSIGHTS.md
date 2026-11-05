# Voxshift Insights (dashboard and reports)

Insights is the plan to give executives a home page and reports worth looking at. It has three parts:

- **one set of figures** for a customer;
- an **Overview** home page;
- a **Reports** area that exports and emails the same figures.

Because the Overview and Reports read the same figures, they never disagree.

The proposal, mock-ups and plan were agreed on 5 November 2026. The five steps are:

| Step | What | State |
| --- | --- | --- |
| 1 | Foundation: shared figures, daily snapshots, site go-live dates | **Live** (2026.11.4) |
| 2 | Customer Overview home page (today's list moves to a My work tab) | **Built** (section below) |
| 3 | Reports area: catalogue, periods, comparison, Excel and CSV | Planned |
| 4 | Executive summary PDF and scheduled emails | Planned |
| 5 | All-customers view, Portfolio report, Present mode | Planned |

The charts use Fluent UI's chart library (`@fluentui/react-charts`, pinned), so they follow the app theme, the customer's
brand colour and dark mode. It came in with step 2, the first chart, rather than shipping unused in step 1.

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
| `migration` | sites, sites live and in service, sites by stage, users and numbers in scope and live, port requests, next go-live, programme end, overall status, and one row per site | the home-page progress rules (`ProgressService`, `deriveSiteProgress`), `build_users` / `discovery_users`, `phone_numbers`, `number_port_requests`, the site overview's Target go-live |
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

A site's go-live date is the **Target go-live** field it already had: **Site Data > (the site) > Overview**, stored as
`discovery_sites.overview->>'targetGoLive'`.

- **Who sets it:** project managers, engineers and admins (`discovery:sites:manage`). Customers see it.
- **Where else it appears:** in handover packs, and on the site page next to the number summary
  (`GET /t/:tenantId/insights/sites/:siteId/go-live`). For people who can set it, **Change** opens the Overview tab.
- **Only real dates count:** older sites may hold free text ("Q3 2026"). That counts as no date (`goLiveDate`) until a
  real date replaces it.
- **First agreed date:** saving the overview keeps `first_go_live`, the date first agreed, so a moved date can show
  "first agreed …". It is set the first time a date is given, kept when the date moves, and cleared when the date is
  cleared. Changes are recorded like any other overview change (audit log, and "changed since submitted" on a submitted
  site).

Step 1 (tenant migration `0084`) first added a separate `target_go_live` column with its own date control. That
duplicated this field, and was found when step 2 was checked on www. Migration `0085` folds the column back into the
overview field and removes it. A date set through the column in the minutes it existed is kept, where the overview had
no date. The same migration starts `first_go_live` from each site's current date.

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

## The Overview (step 2)

The home page (`apps/web/src/pages/Dashboard.tsx`) has two tabs. **Overview** (`pages/overview/Overview.tsx`) is the
summary for anyone who wants the picture. **My work** is the list that was the home page before: Needs attention, then each
site's stages. The tab last chosen is remembered in the browser, so engineers who live in My work stay there. The left
menu calls the page **Home**.

The Overview is built only from `/insights/metrics` (the last 30 days, plus the 30 days before for comparisons) and
`/insights/history`. It shows:

- **The brand panel:**
  - the share of users live, as a ring;
  - the headline (`overviewHeadline`), fixed sentences written from the figures, never generated text;
  - the customer's status, the last go-live date and the time the figures were worked out.
- **Five headline figures:**
  - users live and numbers live, each with a trend line from the snapshots;
  - incident targets met, compared with the 30 days before, and open incidents (P1, P2);
  - changes applied first time.

  Without Managed Services, sites live and open service requests replace the two incident figures. Each figure opens the
  page behind it when the user can open that page.
- **Users live against plan:**
  - The actual line is the daily snapshots plus today's figure.
  - The plan (`goLivePlan`) runs from today: a site's users count from its target go-live date. It is drawn as steps.
  - When there are no dates yet, or little history, the card says so.
- **Sites by stage and Next go-lives:** up to six sites not yet live, soonest first, with their status.
- **Service health:**
  - incident targets met, as a ring;
  - service requests: median time to complete, and the share completed with an assistant;
  - device availability.

  Each card appears only when the customer has that part switched on.
- **Needs a decision:** sites off track or at risk (with the reason), open P1 incidents, and sites without a go-live
  date (for people who can set one).

Colours come from Fluent theme tokens: the customer's brand colour, and the palette colours for good, warning and bad.
That makes both themes and customer branding work. Loading shows a skeleton of the layout.

## Tests

- `packages/shared/src/insights.test.ts`: the go-live rules, the customer status, periods and snapshot totals.
- `tests/db/src/insights/insights.db.test.ts`: the queries behind the figures, go-live dates (read from the overview, first date kept,
  free text ignored, site scope), what each role sees, one snapshot a day, history, and removing old snapshots.
