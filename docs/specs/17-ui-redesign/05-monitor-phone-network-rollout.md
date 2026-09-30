# 17.05 Monitors, Phones, Network rollout

Child of the [spec 17 umbrella](index.md). The three thin categories, done last.

## Summary

Apply the new list layout and the shared tabbed detail framework (built in child 04)
to Monitors, Phones, and Network. These three are thin: Monitors and Phones carry
only assignment beyond their detail fields, Network only its own fields, so they
roll out together once the framework is proven on printers and computers.

## Requirements

**User stories**:
- As any user, I want every remaining asset category to match the new design, so the
  whole app reads as one product.

**Acceptance criteria**:
- **AC-5.1**: The Monitors, Phones, and Network list pages use the new list layout
  (restyled header without the photo hero, the type's filters, the redesigned table,
  Columns / Export / Scan QR, "New <Type>").
- **AC-5.2**: Their detail pages use the shared tabbed framework (child 04). Tab
  sets: Monitors and Phones → Overview, Assignment, Activity; Network → Overview,
  Network, Activity. Overview leads.
- **AC-5.3**: Existing behavior is preserved: assignment and history (spec 16) for
  Monitors and Phones, the spec 10 detail fields for all three (the Network tab shows
  Network's fields), and child 02 image upload/display on all three.

## Decision

**Chosen option**: reuse the child 04 tabbed detail framework and the child 03 list
layout with per type tab configs for the three thin categories, in one slice.

**Rationale (inline)**: the framework and list layout already exist after children 03
and 04; these three categories add no new subsystem, only their own detail fields
(and assignment for two of them), so they are configuration over the existing shell
and safely batched together.

## Feature design

**Detail framework**: the shared tabbed detail from child 04, configured per type:
| Type | Tabs |
|---|---|
| Monitor | Overview, Assignment, Activity |
| Phone | Overview, Assignment, Activity |
| Network | Overview, Network, Activity |

**No new data model**: presentation only; reads spec 10 fields, spec 16 assignment
(Monitors/Phones), and child 02.

**Security model**: unchanged; each action keeps its current gate, viewing open to
`asset:read`.

**Critical test scenarios**:
- Each of the three list pages renders the new layout with its filters + empty
  state, verifies **AC-5.1**.
- A monitor detail shows Overview + Assignment + Activity; a network detail shows
  Overview + Network + Activity, each intact, verifies **AC-5.2**, **AC-5.3**.
- An image uploaded to a phone shows on its detail + list row, verifies **AC-5.3**.

## Build plan

1. Configure the shared tabbed detail (child 04) for Monitors, Phones, and Network
   with their tab sets; preserve behavior. Satisfies **AC-5.2**, **AC-5.3**.
2. Roll the new list layout out to Monitors, Phones, Network. Satisfies **AC-5.1**.
3. Confirm child 02 image upload/display on all three. Satisfies **AC-5.3**.
4. Regression tests: assignment (Monitors/Phones) and the detail fields still work.
   Satisfies **AC-5.3**.

## Consequences

**Positive**: the whole app now reads as one designed product; one list layout and
one detail framework across every asset type.

**Negative / tradeoffs**: touches three more list pages and three detail configs,
but each is thin and rides the proven framework.

**Neutral**: no new data; purely configuration of the existing shell.
