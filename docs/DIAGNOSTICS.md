# Incident diagnostics - runbook reference

Read-only checks that answer the first questions about a Teams voice incident: is the person set up
for calling, who has this number, can the queue's agents take calls, do the routes point anywhere,
is emergency calling set up, what changed lately. Rules and wording are in
`packages/shared/src/diagnostics.ts`; the facts are gathered by
`apps/api/src/modules/incidents/incident-diagnostics.service.ts`.

## What they look at (and do not)

They run on what Voxshift already holds: the **last tenant Discovery** (`tenant_objects`,
`tenant_users`, `tenant_policies`, object history) and the customer's **design** (Design & Build,
number inventory, deployments, service requests). They **never call the customer's tenant**, so they
are instant, change nothing, need no connection session, and can be run by anyone with `inc:manage`
or by an assistant within its autonomy.

Every result says how old the Discovery is (`dataAsOf`) and adds a warning when there has never been
one or it is 7 days old or more. A check is only as good as that data: run a Discovery first when the
incident is about something that changed in the last hours.

Not available (no source of truth in Discovery yet): live Teams presence or sign-in state, SBC and
trunk health, certificate expiry, call quality data (CQD). Those need a live connection or a feed
(chunk 8) and are not guessed at.

## The checks

| Key | Input | Finds |
|---|---|---|
| `user_voice` | email or name | not in Discovery or ambiguous; account disabled or gone; Enterprise Voice off; no Teams Phone licence; no usage location; no number; the same number on another account; the number's tenant record unassigned or not activated; no voice routing policy; calling policy or number different from the design |
| `number_check` | phone number (any format) | not in the tenant; assigned to nobody, to two people, or to a person and a resource account; activation state; Voxshift inventory disagreeing with the tenant; a design row expecting the number for someone who does not have it |
| `queue_check` | name of a call queue or auto attendant | not found or ambiguous; no agents; agents who cannot take calls (removed, disabled, Enterprise Voice off, not found); overflow, time-out, no-agent or menu targets that no longer exist; no resource account or no number; agents in the design who are not in the live queue and the reverse |
| `routing_check` | none | no gateways, all disabled, routes with no gateway or only dead or disabled ones, PSTN usages that do not exist |
| `emergency_check` | none | no emergency locations, unvalidated locations, locations without a civic address, how many voice users have an emergency calling policy |
| `recent_changes` | none | tenant objects added, changed or removed in the last 7 days, deployments (failures first), service requests deployed, planned or built |

A result is `ok`, `warn`, `fail` or `unknown` (the worst finding, or nothing to check), with a one-line
`summary` and the list of `findings` (`ok` / `warn` / `fail` / `info`, each with a title and optional
detail).

## Which checks for which incident

`diagSuggest` (shared) picks them from the category, the incident's linked items, its answers
(which queue, which numbers) and any email addresses in the description: a queue incident starts with
`queue_check`, a numbers one with `number_check`, emergency with `emergency_check`, Direct Routing with
`routing_check`, users and call failures with `user_voice` for each named person, and
`recent_changes` always. The incident page offers these as one-click buttons.

## Where they appear

- **Incident page, Checks card** (engineers and admins): suggested checks, a picker to run any check, and
  the results with who ran them (assistants as "Name (AI)"), when, and the age of the data. Customers
  never see them.
- **Timeline**: each run adds an internal entry ("User voice setup: anna@contoso.com: 1 problem...").
  Running a check does **not** change the incident (no new version), so it never makes another worker's
  view stale.
- **Stored** in `incident_diagnostics` (tenant migration 0051): runbook, input, subject, status, summary,
  findings, `data_as_of`, who ran it, and the proposal it carried out (if any).

## API

People: `GET /api/t/:tenantId/incidents/:id/diagnostics` (the catalogue, results, suggestions) and
`POST` the same path with `{runbook, input?}` (`inc:manage`).

Assistants (`docs/AGENTS.md`): `GET /api/agent/v1/incidents/:tenantId/:id/diagnostics` and `POST` the same
path with `{runbook, input?, proposalId?}`. The incident an agent reads (`GET .../incidents/:tenantId/:id`)
also carries its latest `diagnostics` and `suggestedChecks`.

- Needs the `note` scope, a held claim, and the **read-only diagnostics** autonomy for the customer:
  - level 3 (act alone): runs directly;
  - level 2 (act with approval): the check must be an approved `external` proposal with
    `actionClass: "diagnostic_read"`, named in `proposalId`; the proposal is then marked done with the
    result;
  - level 1: propose the check (`403` `propose_instead`); level 0: refused.
- A person who took the incident over locks the assistant out (`409` `taken_over`).
