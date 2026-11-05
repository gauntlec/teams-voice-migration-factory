# Voxshift Insights (dashboard and reports)

Insights is the plan to give executives a home page and reports worth looking at. It has three parts:

- **one set of figures** for a customer;
- an **Overview** home page;
- a **Reports** area that exports and emails the same figures.

Because the Overview and Reports read the same figures, they never disagree.

The proposal, mock-ups and plan were agreed on 5 November 2026. The five steps, and a sixth that finishes what the proposal
promised, are:

| Step | What | State |
| --- | --- | --- |
| 1 | Foundation: shared figures, daily snapshots, site go-live dates | **Live** (2026.11.4) |
| 2 | Customer Overview home page (today's list moves to a My work tab) | **Live** (2026.11.5) |
| 3 | Reports area: catalogue, periods, comparison, Excel and CSV | **Live** (2026.11.6) |
| 4a | Executive summary report, and a PDF of every report | **Live** (2026.11.7) |
| 4b | Scheduled reports by email, with the PDF attached | **Live** (2026.11.8) |
| 5 | All-customers view, Portfolio report, Present mode | **Live** (2026.11.10) |
| 6a | Assistant activity report (promised in step 5) | **Built** (section below) |
| 6b | Reports › Sent: every scheduled report sent, kept to look back on (promised in step 4) | **Built** (section below) |
| 6c | A site filter on the reports that can be cut by site (promised in step 3) | To do |
| 6d | Device availability over the report's period, not just the last 24 hours (promised in step 3) | To do |

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

## Reports (step 3)

**Reports** in the left menu (`/reports`, `apps/web/src/pages/reports`) lists the reports the person can open for the active
customer (`reportAvailable`), with the same rules as the data behind each one:

| Report | Period | Data | Who |
| --- | --- | --- | --- |
| Migration progress | yes | `/insights/metrics` now, and `/insights/history` for the period | everyone on the customer |
| Change log | yes | `/insights/changes` (new): changes by live runs, newest first, at most 5,000 | people who can see deployments or the customer's audit log |
| Incidents and service levels | yes | `/incidents/report` | Managed Services on, `inc:read` |
| Service requests | yes | `/service-requests/report` | Managed Services on, `sr:read` |
| Assistant activity | yes | `/insights/assistants` (step 6a) | Managed Services on, `inc:read` or `sr:read` |
| Device status | no (now) | `/device-status` | Monitoring on, `monitoring:read` |
| Licences and costs | – | links to Discovery › Licences & costs (`/discovery?tab=licences`) | `tenantdiscovery:read` |

**Periods.** Each report page (`/reports/:key`) takes a period:

- The presets are last 30 days, this month, last month, this quarter, last quarter and last 12 months. Custom dates are
  also possible.
- The choice is kept in the page address (`?period=`, or `?from=&to=`), so a report can be bookmarked or shared.

**Comparison.** Incidents and Service requests compare with the period before. A whole month or quarter compares with
the whole one before it; any other period compares with the same number of days before. Migration progress compares
with the first daily snapshot in the period.

**One model.** Every report is built in `packages/shared/src/reports.ts` as a list of sections: figures (each with the
previous value, the change, and whether up is good), tables and notes. One component (`ReportView`) draws any report.
The same sections become the exports:

- **Excel:** a Summary sheet (customer, period, every figure with the comparison, the notes) and a sheet per table.
- **CSV:** the largest table.

So the screen and the files can't disagree, and step 4's PDF uses the same sections.

On screen, long tables show their first 200 rows, with a button to show the rest; the exports always hold every row.
The incident and service request report dialogs on the Incidents and Service Requests pages are gone. Their **Reports**
menu items open the new pages.

## Executive summary and PDFs (step 4a)

**Executive summary** (`buildExecutiveSummary`) is the first report in the catalogue, opening on last month. It is one
page for a review meeting:

- **The headline:**
  - a title line, the Overview's, counting sites as at the end of the period;
  - fixed sentences about what the period did: users and sites that went live, incident targets met (with the period
    before), service requests completed;
  - the next go-live and the worst risk.
- **Headline figures,** each against the period before: users, sites and numbers live; incident targets met and
  incidents raised; service requests completed; changes applied first time; device availability.
- **Risks and decisions:** sites at risk or off track (with the reason), open P1 incidents, and sites with no go-live
  date.
- **Next go-lives:** up to eight.

For a period that has ended, the migration figures are as at its last daily snapshot, and the report says so.

**Download PDF** is on every report. `GET /t/:tenantId/insights/reports/:key/pdf` takes the same query as the page
(`?period=`, `?from=&to=`, `?compare=`, `reportQuerySchema`).

- **Built on the server:** `InsightsReportsService` builds the report from the same shared builders and data as the
  page, so the PDF says what the page says. `reportAvailableFor` is checked first, the same rule the page uses.
- **Drawn with pdfkit:** `report-pdf.ts`, with no browser, so the image stays small and no Chromium advisories can
  block a release. It draws the Voxshift mark and wordmark, a tinted headline panel, figure tiles with the change in
  green or red, and tables with purple heading rows.
- **Long tables:** the heading row repeats on each new page. Column widths start from each column's longest word, so
  words never break. A report with a table of more than six columns prints in landscape, and every page has a footer
  with its page number.
- **Fonts:** the PDF uses the standard Helvetica fonts, so no font files ship with the app. They cover Western
  European text; any other character prints as "?" (`pdfText`).
- **Very long cells:** a cell over 600 characters is cut with "...". On screen, a cell over 240 characters shows four
  lines, with the full text in its tooltip. The Excel export always has the whole text.

## Scheduled reports (step 4b)

**Reports › Scheduled** is for staff who can set it up (`reports:schedule`: Super Admins, project managers and
engineers). A schedule names a report, how often, and who gets it:

- **How often:** **Monthly** sends on the 1st of each month at 07:00 UTC, covering last month. **Quarterly** sends on
  1 January, April, July and October, covering last quarter (`nextScheduleRun`, `SCHEDULE_PERIOD`). Sending at 07:00
  leaves room for the daily snapshot of the 1st.
- **Who:** only people who can open the customer (`candidates`, the same rule as TenantGuard): Super Admins, and the
  customer's members, staff and its own users, active only. At most 25. Anyone else is refused.
- **Which reports:** only reports the customer has. The Device status report needs Monitoring, for example.
- **Schedule button:** a report page's **Schedule** button opens the form with that report chosen.

**Sending.** `InsightsScheduleService` checks every 15 minutes in the api (`REPORT_SCHEDULES=off` switches it off). A
due schedule first moves its next send, so a failure can never send twice. Then, for each person:

1. It builds the report **as that person**: their role, and a site contact's own sites only (`InsightsReportsService`).
2. It draws the PDF.
3. It queues a `scheduled_report` email with the PDF attached (docs/EMAIL.md).

Someone who can no longer open the customer (removed, switched off, or no longer a member) is skipped. The schedule
records the outcome (sent, partly sent, email off, not sent) with the detail. While email is switched off nothing is
sent, and the schedule says so. **Send now** sends straight away for the period it would cover now, and leaves the next
send where it is. Creating, changing, sending now and deleting are recorded in the customer's audit log.

**The hub.** An installation that sends mail through the hub needs hub PR #15 live before attachments go through. Until
then the hub refuses the message, which the email log shows as failed.

## All customers and Present mode (step 5)

**Home › All customers** is for staff who work across customers (`insights:portfolio`: admins, project managers and
engineers, with more than one customer). It shows every customer the person can open: every active customer for a
Super Admin, the customers they are a member of for other staff. Each row comes from that customer's own Overview
figures, worked out as that person (`InsightsPortfolioService`, `GET /insights/portfolio`, cached for a minute).

- **Order (`sortPortfolio`):** worst first. A customer whose figures could not be read comes first, then off track, a
  priority 1 open, at risk, on track, no go-live dates, and all live. Selecting a customer opens its Overview.
- **Totals (`portfolioTotals`):**
  - users and sites live, with the users who went live in the last 30 days;
  - incident targets met, weighted by how many targets each customer measured;
  - open P1 and P2 incidents;
  - customers needing attention.
- **A customer that can't be read** shows as "Figures unavailable" instead of failing the page.
- **Portfolio report** (`buildPortfolioReport`): a headline, the totals and the customers table. Download it as a PDF
  (`GET /insights/portfolio/pdf`) or export it to Excel.

**Present** (Home, on Overview and All customers) shows the page full screen and a size up, for a meeting-room screen.

- From **Overview** it presents the customer.
- From **All customers** it presents the All customers view, then each customer's Overview in turn, every 20 seconds,
  with a progress bar.
- The arrow keys move between slides, space pauses and Esc leaves. Each slide is the live page, so its figures are
  current. Leaving full screen ends Present mode.

## Assistant activity (step 6a)

**Assistant activity** (Reports, Service group) says what the AI assistants did for the customer in the period
(`GET /insights/assistants?from=&to=`, `InsightsAssistantsService`, `buildAssistantReport`). It compares with the period before,
like every report with a period, and has its PDF, Excel and CSV like the rest.

- **Who:** Managed Services on, and `inc:read` or `sr:read`. The incident figures need `inc:read` and the service request
  figures `sr:read`; a person with only one sees only that part. A site contact sees only their own sites' incidents and
  requests.
- **Worked:** the incidents and service requests an assistant claimed in the period. The headline counts each item once,
  however many assistants worked it.
- **Steps proposed:** proposals made in the period, by how they stand now. Approved covers approved, running, done and failed
  (a person said yes). **Approved by a person** is approved out of approved and rejected; expired and waiting ones aren't
  decided. **Typical time to a decision** is the median from proposal to decision.
- **Handed over** is a claim the assistant ended by handing the work to a person. **Taken back** is one a person ended:
  taking over, or giving the work to someone else.
- **Resolved / completed:** incidents the assistant moved to Resolved itself, and service requests whose verified deployment
  it ran (the same rule as "fixed by" and "completed by an assistant" in the incident and service request reports).
- **Tables:** one row per assistant that did anything (Voxshift's own are marked "(Voxshift)"), and the steps by kind.

## Reports › Sent (step 6b)

**Reports › Sent** sits next to Scheduled, for the same people (`reports:schedule`). It lists every copy of a scheduled
report emailed for the customer, newest first (at most 500), from the email log (`InsightsScheduleService.sent`,
`GET /insights/schedules/sent`).

- **Each row:** when it went (and who pressed Send now, if anyone), the report and its period, who it went to (for a test
  customer whose mail is redirected, who it was for), and the email's state: waiting to go, sent, failed (with the reason)
  or not sent.
- **Open report** opens the same report for the same period, as the person looking.
- **PDF sent** downloads the copy that went, built as its recipient, while it is kept: 90 days, the same as the email
  attachment (`GET /insights/schedules/sent/:messageId/pdf`). Only this customer's scheduled reports can be read this way.

## Tests

- `packages/shared/src/insights.test.ts`: the go-live rules, the customer status, periods and snapshot totals.
- `packages/shared/src/reports.test.ts`:
  - the Executive summary: end-of-period figures, its sentences, its risks;
  - report queries, and which reports each person can open;
  - report periods and comparisons, and figure changes;
  - the incident report;
  - the Excel sheets, CSV quoting and file names.
- `tests/db/src/insights/insights.db.test.ts`:
  - the change log: newest first, with the site and who ran it, and site scope;
  - the queries behind the figures, and what each role sees;
  - go-live dates: read from the overview, first date kept, free text ignored, site scope;
  - one snapshot a day, history, and removing old snapshots.
- `tests/db/src/insights/schedules.db.test.ts`:
  - only people who can open the customer, and only reports it has;
  - due sends: one copy per person built as them (a site contact's own sites), the PDF attached and kept with the email,
    the link to the right customer, someone who lost access skipped, the next send moved;
  - nothing sent while email is off;
  - changing (a new frequency moves the next send), pausing and deleting, with the audit log;
  - Reports › Sent: newest first, the report link, the PDF while it is kept, nothing from another customer.
- `tests/db/src/platform/mail-settings.db.test.ts`: attachments over SMTP and to the hub as base64.
- `tests/db/src/insights/portfolio.db.test.ts`: who sees which customers (Super Admin, a member engineer, an engineer
  with none), each customer's own figures, and a customer whose figures fail shown as unavailable.
- `tests/db/src/insights/assistants.db.test.ts`: each assistant's counts in a period (claims, proposals by state, hand-offs,
  take-backs, resolved, completed, time to a decision), a site contact's sites only, the areas each role can read, and the
  comparison with the period before.
- `tests/db/src/insights/http.db.test.ts`, the real wiring over HTTP:
  - the figures, history and a site's go-live date answer, and a bad period is refused;
  - a PDF of the Executive summary and of the Change log (a real `%PDF` file, with its name);
  - the refusals: Monitoring off, an unknown report, a backwards period;
  - the All customers view and its PDF for staff, refused for a customer user.
