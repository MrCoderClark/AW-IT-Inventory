# 17.04 Computers redesign

Child of the [spec 17 umbrella](index.md). The heaviest non printer category, its
own slice.

## Summary

Bring the new list and tabbed detail to Computers, and extract the reusable tabbed
detail framework from the printer detail (child 03) along the way. Computers is its
own slice because it is roughly flagship sized: it carries three existing
subsystems (live scan health, tracked software, assignment) that all move into tabs,
so it has the most regression risk of the non printer categories.

## Requirements

**User stories**:
- As any user, I want the Computers pages to look and work like the redesigned
  printer pages, with health, software, and assignment each on its own tab.

**Acceptance criteria**:
- **AC-4.1**: The Computers list uses the new list layout (restyled header without
  the photo hero, the type's filters, the redesigned table, Columns / Export / Scan
  QR, "New Computer") matching the printer list.
- **AC-4.2**: The Computer detail uses the shared tabbed detail framework with tabs
  Overview, Live scan (health), Software, Assignment, Activity; Overview leads with
  the Asset Information card plus summaries of the other tabs.
- **AC-4.3**: Every existing computer behavior is preserved under the new layout:
  live scan health, tracked software (spec 15), assignment and history (spec 16),
  the spec 10 computer detail fields, and child 02 image upload/display. Nothing
  regresses.

## Decision

**Chosen option**: extract the printer detail's tabbed shell into a shared,
type driven detail framework, then configure it for Computers by mapping today's
existing panels onto tabs. Reuse the list layout wholesale.

**Rationale (inline)**: child 03 already builds the list layout, the `Tabs` shell,
and the card patterns; the new work here is generalizing the detail shell to a per
type tab configuration and moving today's computer panels into it. Doing Computers
alone, before the three thin categories, contains the regression risk of its three
subsystems in one slice rather than mixing it with simpler pages.

## Feature design

**Detail framework**: a shared tabbed detail (generalized from child 03) that takes
an asset plus a per type tab configuration; each tab renders an existing panel.
Computer tab map:
| Tab | Panel (exists today) | Source |
|---|---|---|
| Overview | Asset Information card + summaries | spec 10 fields + the below |
| Live scan | machine health (OS, CPU, RAM, disk, uptime) | collector `machines` |
| Software | tracked software panel | spec 15 |
| Assignment | current holder + assignment history | spec 16 |
| Activity | derived feed (assignment + scan events) | existing history |

**No new data model**: presentation only; reads specs 10, 15, 16, the collector
machine summary, and child 02.

**Security model**: unchanged; each action keeps its current gate, viewing open to
`asset:read`.

**Critical test scenarios**:
- The Computers list renders the new layout with its filters + empty state, verifies
  **AC-4.1**.
- A computer detail shows Overview + Live scan + Software + Assignment + Activity,
  each with its existing content intact, verifies **AC-4.2**, **AC-4.3**.
- An image uploaded to a computer shows on its detail + list row, verifies
  **AC-4.3**.

## Build plan

1. Extract the shared tabbed detail framework from the printer detail (child 03),
   parameterized by a per type tab config. Satisfies **AC-4.2**.
2. Configure the Computer detail: map live scan, software, assignment, activity, and
   the spec 10 fields onto the tab set; preserve behavior. Satisfies **AC-4.2**,
   **AC-4.3**.
3. Roll the new list layout out to Computers ("New Computer", filters, table).
   Satisfies **AC-4.1**.
4. Confirm child 02 image upload/display on computers. Satisfies **AC-4.3**.
5. Regression tests: live scan, software, and assignment still work under the new
   layout. Satisfies **AC-4.3**.

## Consequences

**Positive**: the reusable tabbed detail framework the thin categories (child 05)
then consume for free; Computers, the richest asset, on the new design.

**Negative / tradeoffs**: the highest regression surface of the rollout (three
subsystems moving into tabs at once), which is exactly why it is its own slice.

**Neutral**: no new data; the arrangement of existing panels under the new shell.
