# Verify: OPUS UI redesign · spec 17 · updated 2026-09-30
_Steps derived from spec 17 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. Built child by child; sections are added as each child lands._

## Child 01 — Design system (AC-1.1 to AC-1.6)

Run web commands in `web/`.

### Commands
- [ ] `npm run check:no-teal` → prints "No teal literals found." (exit 0)   → AC-1.1
- [ ] `npm test` → passes, including `no-teal-literal.test.ts`              → AC-1.1
- [ ] `npx tsc --noEmit` (or `npm run build`) → no type errors             → AC-1.1..1.6

### UI / manual (needs `npm run dev`, checked in a browser)
- [ ] Open the app in a fresh browser profile (no stored theme) → it loads in **light**, not dark   → AC-1.2
- [ ] Toggle the theme → **dark** applies and the accent is still **blue** (no teal), contrast holds → AC-1.2
- [ ] In both themes, confirm buttons, active nav, links, and focus rings are **blue**, never teal   → AC-1.1
- [ ] Sidebar is **light** app wide; the active nav item is **blue text on a light-blue background** with a blue left bar → AC-1.3
- [ ] Keyboard-tab through the sidebar → every item shows a **visible focus ring** and is reachable   → AC-1.3
- [ ] Visit every route in **light** and check contrast + layout (no broken contrast, no teal, nothing dark-only): `/` dashboard, `/computers`, `/monitors`, `/printers`, `/phones`, `/network`, `/software`, `/people`, `/people/[id]`, an asset detail page, `/locations`, `/scans`, `/admin`, `/login` → AC-1.6
- [ ] `HeroHeader` renders a title/subtitle/actions (and, with a `backgroundImage`, keeps text AA legible over the scrim) — mount it or confirm once child 03 lands the printers list → AC-1.4
- [ ] `Tabs` strip: click and **arrow-key** between tabs → the blue underline tracks the active tab and panels swap without navigation — confirm once child 03/04 mount it, or via a smoke mount → AC-1.5
- [ ] `docs/Design/design-system.md` reads as the new light/blue direction (no leftover teal, dark-first guidance) → AC-1.6

## Acceptance-criteria coverage
- AC-1.1 (single blue accent, no teal) — `check:no-teal` + `no-teal-literal.test.ts` + visual blue check
- AC-1.2 (light default, blue dark toggle) — fresh-profile load + toggle check
- AC-1.3 (light sidebar, blue active, focus/keyboard) — sidebar visual + keyboard-tab
- AC-1.4 (HeroHeader) — component built; visual confirm when mounted (child 03)
- AC-1.5 (Tabs, keyboard) — component built; visual confirm when mounted (child 03/04)
- AC-1.6 (every page under new tokens, doc rewritten) — per-route light pass + design-system.md review
