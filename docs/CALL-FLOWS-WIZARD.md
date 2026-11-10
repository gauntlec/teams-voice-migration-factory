# Call Flows (preview): plan

Version 0.1 (draft for review), 10 November 2026. From Chris Rae's feature request "Visual Auto Attendant and Call Queue Wizard".

## What Chris asked for

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
5. **Holidays, and a session with Chris on real sites.** The "preview" label stays until he's happy.

Steps 1 and 2 are a first PR Chris can try. Each step after that is its own PR.

## Decisions for Craig and Chris

1. **Top level:** if the first answer is "Ring a group of people", the number goes straight to a call queue, with no auto attendant in front. That's simpler, but a menu can't be added later without rebuilding. Or always put an auto attendant at the front? I propose straight to the queue, with an "Add a menu in front" button later.
2. **Where it lives:** Site Data > Call flows gets a **New call flow (preview)** button beside the existing two. Should customers see it too, or engineers only while it's a preview?
3. **Number reuse:** if the number is already on a voice app, offer to open that flow instead of starting a new one?
4. **Holidays:** OK to leave them to phase 5?
