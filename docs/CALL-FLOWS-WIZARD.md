# Call Flows (preview): plan

Version 0.4, 11 November 2026. From the feature request "Visual Auto Attendant and Call Queue Wizard". 0.2: the four decisions answered, and step 2 built. 0.3: step 3, the canvas. 0.4: step 4, reopening, messages, keyboard and screen readers.

## What was asked for

- A **second, alternative** wizard called **Call Flows**, clearly labelled as a preview. The existing Auto Attendant and Call Queue wizards stay exactly as they are.
- A visual screen, like the call flow diagrams in the handover pack, where the call flow is built up.
- The person using it shouldn't need to know what a resource account, auto attendant or call queue is.
- It always starts with the **phone number**.
- It uses selectable **icons**, keeping drop-downs to a minimum.
- It asks about **requirements**, not settings. For example: "Same behaviour 24x7, or different at different times of day?"

## The key design choice: a new editor, the same answers

The new wizard saves **exactly what the existing wizards save**:
- one Auto Attendant capture;
- one Call Queue capture per "ring a group of people";
- linked to each other by `flowId`, as "Set up a new call queue" does today;
- the phone number on a resource account row.

So everything downstream works unchanged: the Call flows list, the diagram, Import to Design & Build (with #98's one-step import of nested queues), deployment and the handover pack. The preview adds no new data to look after. Captures it makes are marked `editor = 'call-flows'` so they reopen in it. They can still be opened in the classic wizards.

## The screens

1. **"What number will people call?"**
   - Pick one of the site's spare numbers (tiles, searchable), or type one.
   - Behind the scenes, this is the resource account and its number.
2. **"Does it work the same way all the time?"** Two big tiles:
   - **Same 24x7**;
   - **Different during business hours**, which goes on to hours tiles: Mon to Fri 9 to 5, Mon to Fri 8 to 6, or custom. Custom reuses the "Same hours Monday to Friday" control.
3. **"When someone calls (during business hours), what should happen?"** Icon tiles:
   - **Play a menu** ("Press 1 for…"): becomes an auto attendant menu;
   - **Ring a group of people**: becomes a call queue;
   - **Ring one person**;
   - **Go to voicemail**;
   - **Forward to another number**;
   - **Play a message and hang up**.
4. **The canvas.**
   - The flow so far, drawn with the same diagram as the Call flows tab and the handover pack (`@xyflow/react` + dagre, `CallFlowGraph`).
   - Each box has a **+** where something can follow. For example, a menu option leads to the same icon tiles, and a group's "nobody answers" leads to voicemail or a forward.
   - Clicking a box opens a side panel in plain words: who's in the group, how long to ring, what the greeting says, and voice keywords for menu options.
5. **After hours and holidays** (only if chosen in screen 2): the same tiles for the after-hours path. Holidays come in the second phase.
6. **Review**:
   - a written summary, like the handover pack's;
   - what Voxshift will create, named in plain words with the Teams terms in grey ("a phone menu (auto attendant)");
   - **Save**.

**Defaults** (with no questions asked): language and time zone from the site's country and address, voice inputs off, ring time 30 seconds, overflow after 50 callers, voicemail to a shared voicemail group where one exists.

## Build order

1. **Model and translation (shared, unit tested):** a small "visual flow" model, converted to and from the existing wizard answers both ways. A flow saved here then opened in the classic wizard (and the reverse) must round-trip. This is most of the risk, so it comes first.
2. **Screens 1 to 3 and Save:** enough for the common case of a number, then a menu or a group.
3. **The canvas, with + and the side panels.**
4. **After hours, reopening and editing, validation messages, keyboard and screen reader access.**
5. **Holidays, and a session with the requester on real sites.** The "preview" label stays until they're happy.

Steps 1 and 2 are a first version to try. Each step after that is its own PR.

## Decisions (answered 10 November 2026)

1. **Top level:** an auto attendant is always in front by default. When the flow is only "ring this group" all the time, with no greeting, a switch on screen 3 sends calls **straight to the group** (a call queue) instead.
2. **Where it lives:** Site Data > Auto attendants & call queues gets a **New call flow** tile with a **Preview** badge beside the two classic ones. **Engineers only** while it's a preview: customers don't see the tile, and the server refuses them.
3. **Number reuse:** yes. Typing a number that already answers a call flow offers **Open that call flow** instead, and the server refuses to use it again, naming the flow.
4. **Holidays:** left to step 5.

## Step 2 as built

- **Screens:** the number (spare number tiles, searchable, a national "0141 …" finds "+44141 …") and the flow's name; opening hours (Same 24x7, or business hours: Mon to Fri 9 to 5, 8 to 6, or other hours with the classic wizard's hours control); what happens (the six tiles); **after hours** with the same tiles, built now rather than in step 4 because a flow with business hours can't be saved without it; review.
- **Until the canvas (step 3):** a menu's options, a group's people, how their phones ring and what happens if nobody answers are filled in below the tile chosen. A group's other settings take the defaults above.
- **Review:** the written summary, what Voxshift will create with the Teams names in grey, and the language and time zone from the site's country (and US state), which can be changed there.
- **Saving:** one request, `POST /api/t/:tenantId/discovery/call-flows` (TelephonyService.saveVisualCallFlow). Everything is checked first, in words; then the number is taken (a resource account answering the auto attendant, as adding a voice app with a number does), one call queue capture per group, and the auto attendant capture linking to them by id. All are marked `editor = 'call-flows'` (tenant migration 0101). If anything fails, nothing is left behind.
- Reopening came in step 4 (below).

## Step 3 as built

- **The tile screens only choose.** Screen 3 and after hours pick a tile (and the straight-to-the-group switch); the details are filled in on the canvas, the step after them and before the review.
- **The canvas** is the same diagram the Call flows tab and the handover pack draw (`CallFlowEditorCanvas` in `CallFlowDiagram.tsx`, the same boxes, colours and layout), top to bottom, with zoom but no exports. Each box knows where it is in the flow (`visualFlowCanvas` in `call-flows-visual.ts`): the front door, each path, each menu option, each group and what happens when nobody answers. A group reached from two options is one box.
- **A click on a box opens its panel** beside the canvas, in plain words:
  - the front door: the name, the number, the hours, and whether callers can say their choice;
  - a path: what happens (the six tiles), the greeting, and the menu's options, each opening its own panel;
  - a menu option: its button, its name, what a caller can say (when speech is on), and what it does;
  - a group: its name, its people, how their phones ring, and what happens if nobody answers.
- **A + on a box** offers what can follow it: "Add an option" on a menu, "If nobody answers" on a group, "Choose what happens" on a path not chosen yet.
- **"Still to do"** above the canvas names the first thing missing, in the same words the server uses; Next waits until nothing is.
- While the flow is edited the boxes stay where they are until the new layout is ready, and the view is fitted again only when boxes come or go.

## Step 4 as built

- **Reopening.** "Edit call flow" on a flow the preview made (the row's Preview badge) opens it in the preview, on its canvas. Its auto attendant and the groups it made are read back (`visualFlowFromRows`); a group's own row opens the call flow it belongs to. Anything the preview can't show (holidays, an operator, something changed in a classic wizard it doesn't know) opens the classic wizard instead, saying why. Flows the classic wizards made still open there.
- **Saving changes:** `PUT /api/t/:tenantId/discovery/call-flows/:id` (TelephonyService.updateVisualCallFlow). The captures are changed in place: the auto attendant, each group it already had (renamed with its voice app when renamed), a new call queue capture for each new group, and a group taken out is deleted with its voice app unless another Call flow points at it. The number stays, and whether it goes straight to a group can't change here. Everything is checked first.
- **Messages.** Each box with something missing says what, on the box. "Still to do" names the first (the same words the server uses), says how many more, and **Show me** opens that box's panel. When nothing is missing it says so.
- **Keyboard and screen readers.**
  - Under the diagram, **a list of the boxes** in order (what leads to each, how deep it is, "still to do" where something is missing): each is a button that opens the box's panel and moves the keyboard into it.
  - Tiles are buttons that say whether they're chosen; each group of tiles is one Tab stop, and the arrow keys (Home, End) move along it without choosing, so going past a tile can't throw away what was filled in. Enter or Space chooses.
  - "Still to do" is announced as it changes. The panel is a labelled region.
