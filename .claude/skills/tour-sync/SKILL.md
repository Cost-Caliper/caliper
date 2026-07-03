---
name: tour-sync
description: >
  Keep the Caliper dashboard's guided tour in sync with the product. Use whenever changing
  the dashboard UI — adding, removing, renaming, or reordering panels, views, routes, KPI
  cards, or interactive features in the dashboard prototype (.context/caliper-dashboard-demo.template.html)
  or, once the tour ships there, in packages/control-tower. Any change to what a user sees
  on a page means the tour may now skip, mis-describe, or point at something that moved.
---

# Tour Sync

The dashboard has a guided tour (`TOUR_STEPS` + spotlight engine) whose steps target
`data-tour="…"` anchors and describe specific panels with specific numbers and behaviors.
UI changes silently break it in three ways: a step's target disappears (tour dead-ends),
a new surface ships with no step (tour is incomplete), or a step's *description* no longer
matches what the panel shows (tour lies).

## When you change the dashboard UI

1. **Run the mechanical check** before finishing any UI change:

   ```bash
   node .context/check-tour-sync.mjs
   ```

   It fails if a tour step targets a missing anchor, if a `data-tour` anchor (or `kpiHtml`
   `tour:` option) has no step and no allow-list entry, or if the tour's baked demo routes
   (folder/session) vanish from the data. Treat a failure like a failing test — fix the
   tour or consciously add the anchor to `EXCLUDED` with a reason, never ignore it.

2. **Check what the machine can't**: re-read the affected step's `title`/`body` text.
   Does it still describe what the user actually sees (panel names, colors, interactions,
   numbers)? Renamed "Fable fallbacks" → the step must say the new name. Changed the
   fallback marker from blue to red → the step body that says "blue dot" must change too.

3. **New user-visible feature?** Add a `data-tour` anchor + a tour step (or an `EXCLUDED`
   entry with a reason). The check enforces this; the judgment call is yours.

4. **Verify in-browser when steps changed**: `node .context/build-demo.mjs`, open the demo,
   click ✦ Tour, and walk the changed steps end to end (including Done → localStorage flag).

## CI

The check is CI-shaped (exit 0/1, no dependencies). Today it lives beside the prototype.
When the tour ships in `packages/control-tower`, port `check-tour-sync.mjs` into that
package's `test/` (node --test) so `npm test` — and therefore CI — blocks product changes
that orphan the tour. Until then, this skill is the enforcement point: run the script as
part of any dashboard-UI change.
