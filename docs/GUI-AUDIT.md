# Voxshift GUI audit (Apple design principles)

Audit date 2026-10-14. Method and limits are at the end; read them before relying on a finding. Lens: the `apple-design` skill
(response, feedback, wayfinding, familiarity, flexibility, simplicity, craft, restraint), applied to a dense B2B admin tool,
not a consumer app. Severity: **High** = blocks or misleads real users; **Medium** = costs time or trust every day;
**Low** = polish.

## What is already good (keep it)

- **One consistent shell and page pattern**: title, one plain sentence of purpose, then content. Fluent v9 gives keyboard
  support, focus handling and right-to-left for free, and the Teams Admin Center look suits the audience (Familiarity).
- **The Dashboard answers "what needs me?" first** ("Needs attention (3)"), then a per-site stage strip. That is the right order.
- **Copy is plain and specific** ("Nothing is being worked on right now", "Connect to customer tenant"). Specific labels beat clever ones.
- **Tiles act as filters** on Incidents, Service Requests and the console, with state shown in form (red "Overdue", pills) as well as numbers.
- **Landmarks exist** (one `header`, `nav`, `main`), the current nav item carries `aria-current="page"`, and icon-only buttons on
  the Users page all have accessible names (48 of 48 checked).
- **Brand and white-label are token-driven** (`theme.ts`, `BrandTheme.tsx`), so a customer accent colour flows through the Fluent components.
- Pagination keeps the previous page on screen while loading (`keepPreviousData`), so lists do not flash empty.

## Findings

| # | Sev | Area | Finding and evidence | Recommendation | Effort |
|---|---|---|---|---|---|
| 1 | High | Flexibility | **The app does not work on a phone or small window.** The left nav is a fixed 224 px column at every width. At 375 px the content is about 240 px wide, the customer picker is clipped and the Incidents filters wrap one per line. Only the Dashboard has any `@media` rule (2 in 30,000 lines). Engineers will open a P1 on a phone. | Collapse the nav to an icon rail under about 1100 px and a slide-in drawer under 720 px (move the customer switcher into it). Make Incidents, the incident page and Service Requests properly responsive first; leave the dense Design & Build grids desktop-only and say so. | M |
| 2 | High | Wayfinding / a11y | **No real headings and a static document title.** There are 0 `h1`/`h2`/`h3` elements on the pages checked: page titles are Fluent `Text` spans (`Title2`). `document.title` is "Voxshift" on every page, so tabs, history and screen readers cannot tell pages apart. | Render page titles as `h1` and section titles as `h2` (`as="h1"` on Fluent `Text`). Set the title per route ("Incidents · AT&T Voice Consult · Voxshift"). Add a skip-to-content link and an `aria-label` on the nav. | S |
| 3 | High | Craft / a11y | **Amber "differs" text fails contrast.** On Design & Build the amber policy cells are `rgb(211,147,0)` on white, 2.64:1 against a 4.5:1 minimum, and colour is the only signal. | Use a dark amber for text (for example `#8A5A00`, about 5.9:1) on a pale tint, and add a small icon or "differs" tag so colour is not the only cue. | S |
| 4 | High | Wayfinding | **The customer you are acting on is not visible on most pages.** It lives only in the small header dropdown. Incidents, Service Requests, Design & Build and Deployment never name the customer in the page. MSP staff switch between customers all day; acting on the wrong one is the costliest mistake in the tool. | Show the active customer (and a "Test customer" badge) in every page header, as the Dashboard already does. Confirm the customer name in destructive and deploy dialogs. | S |
| 5 | Medium | Familiarity / IA | **"Operations" now means three things.** The new nav section, a Dashboard stage called "Operations" (meaning in service), and the MSP section's console. "Incidents" and "Incident console" use the same icon in different sections. | Rename the stage to "In service" (or the nav section to "Managed service"). Give the console its own icon. Keep a rule: sidebar sections are named for the job, stages for the state. | S |
| 6 | Medium | Simplicity | **Action clusters on list pages.** Incidents has six buttons (Reports, Past notices, Problems, Knowledge, Settings, Raise an incident); Service Requests four. The primary action competes with five equals. | One primary button, then tabs for the views (Queue, Problems, Knowledge, Notices, Reports as the MSP console already does with Queue / Major incidents), and Settings under an overflow or the gear. | M |
| 7 | Medium | Agency / feedback | **Row actions are five 24 px icons in a row, with Delete beside Disable.** On Users the actions are tiny, adjacent and one is destructive. There are no toasts anywhere (0 uses of the toast controller), so success shows as banners or nothing; there is no undo. | Keep one or two frequent actions visible and put the rest in a "..." menu with Delete separated and a confirm that names the consequence. Add toasts for completion ("Invitation sent", "Saved") and undo where it is cheap. Move the always-open "New user" form into a dialog or panel so the list stays the page. | M |
| 8 | Medium | Craft / typography | **Text is small and one-size.** 28 px titles with default tracking, 14 px body, many 12 px helpers and 10 px nav group labels ("Tenancy", "Feedback"). Sizes are px, so the browser's default text size is ignored. | Raise labels to 12 px minimum, tighten large titles slightly (-0.01 to -0.02em), use leading that falls as size rises. Keep 14 px body (right for density). Consider rem-based tokens later. | S |
| 9 | Medium | Craft / layout | **Content width is unbounded.** `main` was 1,905 px wide on a 2,145 px viewport; forms and cards stretch edge to edge. The Design & Build users grid is 2,728 px wide inside a 2,644 px container, so it scrolls sideways with no sign of what is off-screen. | Cap forms, settings and detail pages at about 1100-1200 px; let only grids use the full width. For grids: a sticky first column and header, a visible edge shadow when scrolled, a column chooser and saved views, sorting (none today: 0 `aria-sort`/sort handlers). | M |
| 10 | Medium | Response / feedback | **Loading is spinners, never skeletons** (138 `Spinner` uses, 0 skeletons), so pages jump when data arrives. Empty states are a line of text ("No open incidents. Nothing is being worked on right now.") with no next step. | Skeleton rows for tables and tiles with a short cross-fade to content. Empty states say what to do ("Raise an incident", "Connect a customer tenant") and show once, not beside four zero tiles. | M |
| 11 | Medium | Flexibility | **Dark mode and tokens are half done.** `darkTheme` is defined but never used; there is no `prefers-color-scheme` handling and no theme control. 99 hard-coded hex colours in 12 files (diagrams 39, admin Customers/MSPs 20, Design & Build 7) mean diagrams ignore the customer's accent colour and would break in any dark or high-contrast theme. | Replace literal colours with Fluent tokens or CSS variables (SVG diagrams can read them), wire `darkTheme` to the system setting with a user override, and test with a white-label customer. Respect `prefers-contrast`. | M |
| 12 | Medium | Craft / maintainability | **Spacing and style are ad hoc.** 549 inline `style={{...}}` objects against 88 `makeStyles` uses (118 inline in `BuildSiteWorkspace.tsx` alone, a 2,972-line file). Every inline value is a spacing decision nobody can defend or change in one place. | Introduce a few layout primitives (PageHeader, PageSection, Toolbar, FormRow) using Fluent spacing tokens, and move inline styles into them as pages are touched. Split the three 1,400-3,000 line pages. This also helps AI-assisted maintenance. | L |
| 13 | Low | Accessibility | **No live regions** (0 `aria-live`/`role="status"`/`role="alert"` on the page checked), so save results and errors are not announced; one unlabeled select/input on Users; icon buttons are 24 x 24 (fine for a mouse, too small for touch). | Make status messages `aria-live="polite"` (errors "assertive"), label the stray control, and give icon buttons 32-44 px hit areas on touch widths. | S |
| 14 | Low | Wayfinding | **The Dashboard stage strip has no legend.** The blue outline marks "current step" per site but nothing says so, and stage captions are 10-12 px. | Add a one-line legend or tooltip per chip, and make each chip a link to the page it describes. | S |
| 15 | Low | Motion / restraint | **Motion is Fluent's defaults only** (0 custom transitions); Fluent handles `prefers-reduced-motion` for its own components. That is a sound baseline. | Do not add motion for its own sake. The few places it pays: skeleton to content, side panels that open from the control that triggered them and close the way they came, and any drag interaction (reordering, maps) following the pointer 1:1 and staying interruptible. | S |

## Suggested order

1. **Quick wins (about 2 days)**: 2 (headings, titles, skip link), 3 (amber contrast), 4 (customer in the page header), 5 (rename the stage, new console icon), 8 (label sizes), 13, 14.
2. **Next (about 1-2 weeks)**: 1 (responsive shell and phone-first incident pages), 7 (action menus, toasts), 10 (skeletons, empty states), 6 (list page actions), 9 (width caps, sticky grid columns).
3. **Foundation**: 11 and 12 together (tokens, dark mode, layout primitives, splitting the big pages), then a table component with sort, density and column chooser.

## Status (2026-10-14, after the second implementation pass)

| # | Status | What changed |
|---|---|---|
| 1 | Done for the shell and the main lists | Under 900 px the nav is a drawer opened from a menu button (closes on navigation, Escape, or the scrim); the header, customer picker and page padding shrink; list filters no longer push the page wider. The dense Design & Build and Discovery grids are usable on a phone (scroll sideways, identifier column stays put) but remain desktop-first. |
| 2 | Done | `Page` renders a real `h1` and sets the document title per page; skip-to-content link; the nav is labelled "Main". |
| 3 | Done | Amber warning text uses `colorPaletteMarigoldForeground2` (6.1:1); Design & Build "will change" cells also get a tinted background. |
| 4 | Done | Every customer-scoped page shows the customer name (and a Test customer badge) above its title. |
| 5 | Done | The Dashboard stage is "In service"; the Incident console has its own icon. |
| 6 | Done | Incidents and Service Requests have one primary button and a "More" menu (Reports, Past notices, Problems, Knowledge, Settings / Our targets, Site modes, demo incidents). |
| 7 | Done for Users | Row actions menu with confirms, New user dialog, toasts (`useNotify`); the Incidents demo-incident action also toasts. Other pages can adopt `useNotify` as they are touched. |
| 8 | Done | 12 px nav group labels, -0.01em title tracking, 12 px stage chip detail. |
| 9 | Done | Click-to-sort on the Incidents, Service Requests, both MSP console and Users lists and on the Design & Build / Data Collection grids (natural order, empty values last, three-state: ascending, descending, original). The grids also keep the identifier column in place while scrolling sideways and have a Columns menu (remembered per table in this browser). Forms and detail pages cap at 1200 px; tables show scroll-edge shadows. Sorting applies to the rows loaded on the page. |
| 10 | Done for the main lists | Skeleton rows while loading and empty states with a next step on Incidents and Service Requests; skeletons on both MSP consoles, Customers, MSPs, Problems, Number porting, Handover, Deployment sites, Assistants, Release check and the Discovery tables. Spinners remain inside dialogs. |
| 11 | Done except diagrams | Dark mode: follows the computer, or Light / Dark from the avatar menu (Appearance), remembered per browser; white-label customer themes have a dark variant; literal colours replaced with theme tokens. The two diagrams deliberately stay on light "paper" (like their PNG and PDF exports). |
| 12 | Done (structure) | The four largest pages are split into focused modules (`BuildSiteWorkspace` 2,973 lines to 898 plus `pages/build/*`; `Discovery` 2,509 to 170 plus `pages/discovery/*`; `ServiceRequestPage` 1,480 to 120; `SiteWorkspace` 1,476 to 681). `DangerText` / `MutedText` replace 50 repeated inline colour styles. About 500 other inline style objects remain and can move into `makeStyles` or the shared pieces as pages are touched. |
| 13 | Partly | Toasts are live-region text; the Users search box is labelled. Icon button hit areas unchanged. |
| 14 | Done | Dashboard legend line added. |
| 15 | n/a | No change needed. |

## Method and limits

- Live review of the production-like dev site as a Super Admin on the customer "AT&T Voice Consult": Dashboard, Data Collection, Discovery,
  Design & Build (list and the Luton site), Deployment, Incidents, Service Requests, Incident console, Users and Assistants.
  Measured in the browser: heading and landmark counts, font sizes in use, colour contrast, target sizes, accessible names, content width.
- The phone-width check used the built web bundle against a local mock with sample data, not the live site.
- Code metrics are counts over `apps/web/src` (about 30,000 lines).
- **Not reviewed**: the customer-role views, the incident and service-request detail pages, the wizards (queue, auto attendant),
  Handover, Number porting, hover and focus visuals, keyboard-only and screen-reader walk-throughs, and performance. Findings
  7, 10 and 15 are partly inferred from code and the screens above, so check them on those pages before committing effort.
- Apple's skill is written for consumer and gesture-driven UI; the principles used here are the ones that transfer to an admin tool.
  Its drag, momentum and spring guidance matters only where we add gestures, so it is mostly absent from the findings.
