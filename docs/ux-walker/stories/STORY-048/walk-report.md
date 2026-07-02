# STORY-048 — Theme toggle & persistence gap verification

**Type**: Short · **Persona**: John · **Result**: PASS (regression from catalog is FIXED)

## Background

The catalog (topics/navigation-history.md, gap #1 in the Gaps & Recommendations
section) documented theme as memory-only — a manual toggle was lost on reload,
falling back to `prefers-color-scheme`. Per the task brief, this was "recently
fixed" and needed re-verification.

## Steps executed

1. From dark theme (default), navigated to Sessions tab. Screenshot baseline
   (`step-1-dark-sessions.png`).
2. Clicked the theme toggle (top-right, sun/moon icon button labeled "Toggle
   light/dark theme"). Theme flipped to light **immediately** — no reload, no
   flicker — icon changed from sun (☀) to moon (☾).
3. Screenshotted Sessions list in light theme (`step-2-light-sessions.png`).
4. Switched to Active Session tab, screenshotted the insight card in light theme
   at two scroll positions (`step-3-light-active-session.png`,
   `step-3b-light-active-session-scroll.png`) — covers stat cards, Pareto
   leaderboard bars, and the "Potential savings" panel with OSS substitution
   table.
5. **Reloaded the page** (`agent-browser reload`). Screenshotted immediately after
   (`step-4-after-reload-should-persist-light.png`).
6. Toggled back to dark (`step-5-toggled-back-dark.png`).
7. **Reloaded again** to verify the round trip (`step-6-after-reload-should-persist-dark.png`).
8. Checked `console` and `errors` after the final reload — both clean.
9. Ran `eval "localStorage.getItem('theme') || ..."` to directly inspect storage.
   Result: `"ct-theme=dark"` — confirms the app persists the choice under
   localStorage key **`ct-theme`**, matching the visible state exactly.

## Result

- **Light → reload → still light**: CONFIRMED. Theme persisted across reload,
  along with tab selection and session selection (Active Session, same session).
- **Dark → reload → still dark**: CONFIRMED. Same result toggling the other
  direction.
- **Storage mechanism**: `localStorage['ct-theme']` — directly verified via
  `eval`, not just inferred from visual behavior.
- **No console/page errors** at any point in the toggle/reload sequence.
- **Catalog gap #1 is RESOLVED.** The previously-documented regression (memory-only
  theme, lost on reload) does not reproduce. This story now passes cleanly.

## Legibility judgment — light theme

**Sessions list** (light theme):
- Background white, row backgrounds white/near-white, text dark gray/black —
  strong contrast, easily AA-compliant by eye.
- Date-group headers, badges (ACTIVE pill, wf/sub counts), and cost figures all
  render with clear contrast against the white background.
- Model-tier dots (red/purple/orange) are still visible as color accents on
  white, same as dark theme — no legibility regression.

**Active Session insight card** (light theme):
- Stat cards (Main Conversation, Workflows, Subagents, Biggest Single, Potential
  Savings) use light-gray card backgrounds on white page background — a subtle
  but sufficient separation; the "Potential savings" card additionally gets a
  green border, which reads clearly.
- Pareto leaderboard bars: light-gray unfilled track vs. red/tan/green filled
  segments — good contrast, matches the dark-theme design intent (colors
  unchanged, just background inverted).
- Savings table (opus→GLM-5.2 etc.): strikethrough gray "old price" vs. bold
  black "new price" vs. green "save $X (Y% cheaper)" — all three states
  distinguishable at a glance, no ambiguity.
- No low-contrast or hard-to-read text was found in either screenshot pass.

**Verdict on legibility**: pass. Light theme is a clean, well-executed inverse of
dark — no elements were left dark-theme-only (no un-inverted colors, no
white-on-white or black-on-black artifacts).

## Verdict: PASS — no findings.

Theme toggle instant, persists correctly in both directions via
`localStorage['ct-theme']`, and light theme is fully legible on both surfaces
audited. The catalog's previously-flagged persistence gap is fixed.
