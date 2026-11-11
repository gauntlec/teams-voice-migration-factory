# Service Handover view: plan

Version 0.2, 11 November 2026. From the feature request "Service Handover View"; the decisions below were answered on 10 November 2026.

## What was asked for

- The Service Handover page lists **every site**, with a search box (site name, site code and other details).
- Each site has one of three statuses: **Not created**, **Draft**, **Issued**.
- Clicking a site opens its own page, with buttons to:
  - generate the pack as a draft;
  - re-upload the Word document after manual changes;
  - add an outstanding action;
  - issue the document.
- The main list has a yes/no column for outstanding actions, and whether they are all completed.
- Outstanding actions can be ticked off when done.
- The project manager is reminded, after a number of days set in this section, while actions are still open.

## What existed before (2026.11.27)

- **Packs:** `handover_packs` holds every generated pack: version, `version_label` (major.minor), `draft`/`issued` status, the .docx file, and its scope (`source.siteIds`, one site or several). Per-site version numbers already exist.
- **Notes:** `handover_notes` holds the hand-written sections. Outstanding actions are one note per site, written as free text lines (`description | owner`), so they can't be ticked off or counted.
- **No upload:** the only file a pack has is the one Voxshift generated.
- **Site contacts:** the site's **Provider PM** is in the Site Overview contacts (`providerPm`: platform users or typed names and emails).
- **Email:** email is switched off on www, so reminders need somewhere to show without it.

## Proposal

### 1. The list (replaces today's pack list)

| Column | From |
|---|---|
| Site code, Site name, Country | `discovery_sites` |
| Status | the site's latest pack: none = **Not created**, else **Draft** or **Issued** (with its version, e.g. "Issued 1.2") |
| Last change | when and by whom (generated, uploaded or issued) |
| Outstanding actions | **No**, or **Yes: 2 open of 5** (all ticked = "Yes: all done") |
| Provider PM | from the Site Overview |

- **Search:** the box matches site code, name, country, region and PM. Filter chips: status, and "has open actions".
- **Sort:** by site code; every column header sorts.
- **Customer-wide packs:** a pack covering several sites (today's "all sites" option) stays possible from a secondary button. It doesn't count towards any one site's status, which keeps the three statuses simple.

### 2. The site page (`/handover/sites/:siteId`)

- **Header:** site, status and version.
- **Buttons:**
  - **Generate draft:** today's generator, for this one site.
  - **Upload edited version:** a .docx.
  - **Issue:** today's issue step.
  - **Download.**
- **History:** every version with who, when and what: generated, uploaded or issued. Each can be downloaded.
- **Outstanding actions:** a table with description, owner, added (when and by whom), done (tick, when and by whom), and **Add action**.
- **Notes:** the hand-written sections move here from today's page.

### 3. Re-upload

- An uploaded .docx becomes a **new minor version** of the site's pack. For example, the generated 0.2 is edited in Word and uploaded as 0.3.
- It has `origin = 'uploaded'`. Issuing then issues the uploaded file as it is; Voxshift doesn't regenerate it.
- Generating again afterwards makes a new draft from data. The page warns that this replaces the hand edits, and points to the uploaded version in History.
- **Checks:** .docx only, through the same file store and size limit as other uploads, with the usual virus and type checks.

### 4. Outstanding actions become records

- New table `handover_actions`: `site_id`, `description`, `owner`, `created_by/at`, `done_by/at`.
- **Migration:** one row per line of today's outstanding-actions notes, so nothing is lost.
- **The pack:** the Outstanding Actions table lists the **open** actions, numbered as today. A done action drops out of the next version.
- **Main list:** the yes/no column counts open and total.

### 5. Reminders to the project manager

- **Setting:** on the Service Handover page, per customer: "Remind the Provider PM when actions are still open after **N** days" (default 7, 0 = off).
- **When:** a daily worker job finds sites with an action open longer than N days, not reminded in the last N days.
- **How:**
  - an **email** to the site's Provider PMs who are platform users or have an email address, when email is on;
  - always a **badge** on the Service Handover menu item and the site row ("2 actions overdue"), so it works with email off.

## Build order

1. Actions as records: table, migration of notes, tick off, and the pack reads them.
2. The list and the site page, with generate and issue moved there.
3. Upload edited version, and history.
4. Reminders: setting, daily job, email and badge.

Each step is its own PR, with DB tests. Steps 1 and 2 are the most visible.

## Decisions (answered 10 November 2026)

1. **A pack covering several sites** no longer sets any site's status. Per-site packs are the normal way.
2. **Done actions** drop out of the next pack version; they aren't listed as "Completed".
3. **Reminders** go to the site's Provider PM(s) and to the person who generated the pack.
4. **An uploaded document** still needs the usual issue step and role (engineer or PM).
5. **Customer users** see nothing until it's issued: no drafts and no outstanding actions. The working list of actions and the notes are staff only.

## Progress

- Step 1, actions as records: live in 2026.11.27 (PR #100).
- Step 2, the list and the site page: the site list (`GET handover/sites`), `/handover/sites/:siteId`, and actions and notes kept to staff.
- Steps 3 and 4: not started.
