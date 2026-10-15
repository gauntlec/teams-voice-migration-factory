# Built-in assistants: Triage, Diagnose, Comms, Changes

Voxshift ships four assistants. They are ordinary agents ([AGENTS.md](AGENTS.md)): their own identity,
a per-customer autonomy policy, claims, proposals, the kill switches, everything on the timeline as
"Voxshift Triage (AI)". What makes them *built in* is that the API runs them itself (a pass every
30 seconds), so they have **no tokens and no webhooks**, and their "brain" is rules and templates
(`packages/shared/src/builtin-agents.ts`), not an outside AI service. They work with no key and no
data leaving Voxshift, and they say exactly why they did what they did. An outside agent (an LLM
runtime, a customer's own bot) uses the same API and the same limits.

They do nothing until a Super Admin **adds** each one (Administration -> Assistants -> "Built in to
Voxshift") and **allows it on a customer** (Customers tab), where every kind of action starts at
Suggest or Observe. Starting points worth using once you trust them are on the assistant's Overview.

## What each one does

Each works in **one area**, fixed (outside assistants choose theirs, see [AGENTS.md](AGENTS.md) "Where an assistant works"): **Triage, Diagnose and Comms work on incidents; Changes works on service requests.** The Customers tab therefore shows only the actions that matter for each.

**Triage** (kind: triage). Looks at new, unassigned incidents (not major, not held by a person, at
least 45 seconds old, raised in the last 7 days, 5 per customer per pass, most urgent first), takes a
5-minute lease, and writes one internal note: the known error that matches (with its workaround),
similar open incidents, a possible wider problem when three or more are open at one site, and a
recommendation with a confidence. It also:

- proposes `link_problem` for a matching known error, and `status_change` to *duplicate* for an incident
  raised in the last 30 minutes at the same site with the same category (always a proposal, never
  done by itself);
- acknowledges the incident (`in_progress`) when its **triage** autonomy is "act alone", otherwise
  proposes it;
- lets go of the lease, so the incident is unassigned again for an engineer to pick up.
Needs: triage >= 1 and internal notes >= 1. Does each incident once.

**Diagnose** (kind: diagnostic). Looks at new or in-progress incidents nobody has, that have no
diagnostics yet. Takes the checks the incident points at ([DIAGNOSTICS.md](DIAGNOSTICS.md)) and, by
its **read-only diagnostics** autonomy:

- **act alone (3)**: runs up to 5 of them, then writes the result. If it found a problem it **hands
  over** with a packet (tried, found, recommendation, confidence) which also emails the team; if it
  found nothing it just leaves a note (and says the data is Discovery, not the live tenant);
- **act with approval (2)**: proposes up to 2 checks (an `external` proposal each) for a person to
  approve, and runs each one when approved (the proposal is then marked done). At most 5 proposals
  per assistant can be open at once, so level 3 is the practical setting for read-only checks;
- **suggest (1)**: only says which checks are worth running.

**Comms** (kind: comms). For P1 (every 30 minutes) and P2 (every 2 hours) incidents that are open, not
major, and not on hold for the customer, when no update has reached the customer for that long,
proposes one `customer_update`. The text is a fixed template: the incident title, what stage it is at
("an engineer is working on it", "we are waiting on your carrier ...") and when the next update will
come. It never guesses a cause or promises a fix. Because customer-visible text is capped at "act with
approval", a person always approves it first; it expires after the cadence. It does not draft again
until a full cadence has passed since its last draft, approved or not.

**Changes** (kind: resolver). Works **service requests**, not incidents ([SERVICE-REQUEST-AGENTS.md](SERVICE-REQUEST-AGENTS.md)).
For each open change or removal request nobody has (and nothing for a person to decide, no pending customer approval, not
waiting on the customer, not held by a person) it takes a 5-minute lease and: moves it to Planned, **applies** it to the design,
signs the design off, runs the **What-If**, and **proposes the deployment** with the exact commands. It never deploys on its own
say-so: each pass it also looks for proposals a person approved (onto their own tenant session) and calls the deploy, which the
platform re-checks end to end. Anything it cannot do cleanly (a warning, a design blocker, a What-If with nothing to do or a
warning, a refusal at deploy time such as the change window) it hands over with what it tried and found. Does each request once.
Needs "act alone" for triage, applying the design and What-If, "act with approval" for deploying, and internal notes at Suggest or
better; below that it does nothing (at deploy level 0 it prepares and says so, without proposing). Not offered on incidents.

## Rules they follow like any agent

- Only customers with the assistant enabled, Managed Services on, and the customer's assistants
  switch on; not when the assistant is paused or disabled, or the global kill switch is on.
- Changes need a held lease and the right autonomy; a person who takes the incident over locks them
  out (they stop, and do not touch it again until it is handed back).
- A claim that cannot be taken (someone got there first) is skipped quietly. Errors on one customer
  never stop the pass for the others, and are logged.
- Letting go of an incident clears the assistant as assignee (this applies to every agent, not just
  these: a released incident is nobody's, not "owned" by an assistant that has stopped).

## Asking one

On an incident, engineers can **Ask an assistant**. A built-in assistant does its job straight away, within
its autonomy for the customer: Diagnose runs the checks the incident points at and any email address or number in
the question, Triage looks again and leaves another note, Comms drafts an update for approval. A request is noted
on the timeline (internal) and sent to the assistant as an `incident.assist_requested` event. If the assistant is
set to observe only, the person is told so rather than nothing happening.

## Not built (by design, for now)

No outside AI model is called. A model-backed brain (better wording, free-text understanding) is an
optional later step behind the same autonomy limits, off unless a customer opts in. Meanwhile an
outside agent can be connected through the REST API ([AGENTS.md](AGENTS.md)) or the MCP server
([MCP.md](MCP.md)).
