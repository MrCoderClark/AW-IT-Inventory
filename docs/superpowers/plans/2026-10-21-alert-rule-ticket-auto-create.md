# Per-alert-rule ticket auto-create override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tri-state ticket auto-create override per Spec 30 alert rule (`inherit` | `on` | `off`), wire `meta.alertRuleId` on metric notifications, and resolve overrides in `maybeAutoCreateTicketFromNotification`.

**Architecture:** Column on `alert_rules`; fire path stamps `alertRuleId` into notification `meta`; auto-create reads meta → rule mode → else global type toggle. Admin dialog/table edit the mode.

**Tech Stack:** Drizzle schema, Zod, Vitest DB mocks, existing alert-rules admin UI.

**Spec:** [`docs/superpowers/specs/2026-10-21-alert-rule-ticket-auto-create-design.md`](../specs/2026-10-21-alert-rule-ticket-auto-create-design.md)

## Global Constraints

- Modes: `inherit` | `on` | `off`; default **`inherit`**
- Meta key: **`alertRuleId`** (string UUID)
- Resolution: `on` → create; `off` → skip; `inherit`/missing → global `ticket_auto_create_types[type]`
- Non-metric notifications unchanged (no meta rule id)
- Recover uses same override via same rule id + type `metric-recovered`
- Best-effort: never throw into ingest / notification create
- RBAC: `user:admin` unchanged
- Requires **`npm run db:push`** after schema change (document in PROGRESS)
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell

---

## File structure

| File | Role |
|---|---|
| `web/src/db/schema.ts` | `ticketAutoCreate` column on `alertRules` |
| `web/src/lib/alert-rules.ts` | `TicketAutoCreateMode` + field on `AlertRuleRecord` |
| `web/src/lib/alert-rule-schema.ts` | Zod + form defaults |
| `web/src/db/alert-rules.ts` | `toRecord` / create / update / DEFAULT seed |
| `web/src/db/tickets.ts` | Override resolution in `maybeAutoCreate…` |
| `web/src/db/tickets.test.ts` | Override cases |
| `web/src/db/notifications.ts` | Pass `meta` into maybeAutoCreate |
| `web/src/db/alert-rules.ts` (evaluate) | Stamp `meta.alertRuleId` on createNotification |
| `web/src/components/alert-rule-form-dialog.tsx` | Select field |
| `web/src/components/alert-rules-table.tsx` | Optional column |
| Spec 33 / Spec 30 / PROGRESS / design Status | Docs |

---

### Task 1: Schema + types + Zod + CRUD mapping

**Files:**
- Modify: `web/src/db/schema.ts` (`alertRules`)
- Modify: `web/src/lib/alert-rules.ts`
- Modify: `web/src/lib/alert-rule-schema.ts`
- Modify: `web/src/db/alert-rules.ts` (`toRecord`, create, update, DEFAULT_ALERT_RULES)
- Modify: `web/src/lib/alert-rule-schema.test.ts` (if present — add enum case)

**Interfaces:**
- Produces: `TicketAutoCreateMode = "inherit" | "on" | "off"`
- `AlertRuleRecord.ticketAutoCreate: TicketAutoCreateMode`
- `AlertRuleInput.ticketAutoCreate: TicketAutoCreateMode`

- [ ] **Step 1: Extend schema**

In `alertRules` table definition, after `enabled`:

```ts
    ticketAutoCreate: text("ticket_auto_create")
      .$type<"inherit" | "on" | "off">()
      .notNull()
      .default("inherit"),
```

- [ ] **Step 2: Types + Zod**

In `web/src/lib/alert-rules.ts`:

```ts
export type TicketAutoCreateMode = "inherit" | "on" | "off";

export const TICKET_AUTO_CREATE_LABEL: Record<TicketAutoCreateMode, string> = {
  inherit: "Inherit",
  on: "On",
  off: "Off",
};

export interface AlertRuleRecord {
  // ...existing fields...
  enabled: boolean;
  ticketAutoCreate: TicketAutoCreateMode;
}
```

In `web/src/lib/alert-rule-schema.ts`:

```ts
export const TICKET_AUTO_CREATE_MODES = [
  "inherit",
  "on",
  "off",
] as const satisfies readonly TicketAutoCreateMode[];

// import type TicketAutoCreateMode from alert-rules

export const alertRuleInputSchema = z.object({
  // ...existing...
  severity: z.enum(ALERT_SEVERITIES, { error: "Choose a severity" }),
  ticketAutoCreate: z.enum(TICKET_AUTO_CREATE_MODES, {
    error: "Choose ticket auto-create",
  }),
});

export interface AlertRuleFormValues {
  // ...existing...
  ticketAutoCreate: TicketAutoCreateMode;
}

export const EMPTY_ALERT_RULE_FORM: AlertRuleFormValues = {
  // ...existing...
  ticketAutoCreate: "inherit",
};
```

- [ ] **Step 3: Map DB ↔ record**

Update `toRecord` to include `ticketAutoCreate: row.ticketAutoCreate` (cast if needed).

`createAlertRule` / `updateAlertRule` set `ticketAutoCreate: input.ticketAutoCreate`.

`DEFAULT_ALERT_RULES` entries may omit the field (DB default) or set `ticketAutoCreate: "inherit"`.

- [ ] **Step 4: Fix compile breakages**

Any test fixtures building `AlertRuleRecord` or form values must add `ticketAutoCreate: "inherit"`. Grep for `AlertRuleRecord` / `EMPTY_ALERT_RULE_FORM` / severity-only rule objects in:

- `web/src/components/alert-rules-table.test.tsx`
- `web/src/app/(app)/alert-rule-actions.test.ts`
- `web/src/lib/alert-rule-schema.test.ts`

Update VALID payloads in action tests to include `ticketAutoCreate: "inherit"`.

- [ ] **Step 5: Run focused tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/alert-rule-schema.test.ts src/app/(app)/alert-rule-actions.test.ts src/components/alert-rules-table.test.tsx --run
```

(Quote the `(app)` path.) Expected: PASS after fixture updates.

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/schema.ts web/src/lib/alert-rules.ts web/src/lib/alert-rule-schema.ts web/src/db/alert-rules.ts web/src/lib/alert-rule-schema.test.ts web/src/components/alert-rules-table.test.tsx "web/src/app/(app)/alert-rule-actions.test.ts"
git commit -m @"
feat(spec 33): add alert rule ticketAutoCreate column and types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Override resolution + pass meta from createNotification

**Files:**
- Modify: `web/src/db/tickets.ts` (`maybeAutoCreateTicketFromNotification`)
- Modify: `web/src/db/tickets.test.ts`
- Modify: `web/src/db/notifications.ts` (pass `meta` into maybeAutoCreate)

**Interfaces:**
- Consumes: `alertRules.ticketAutoCreate`, `row.meta?.alertRuleId`
- `maybeAutoCreateTicketFromNotification` accepts optional `meta?: Record<string, unknown> | null`

- [ ] **Step 1: Write failing override tests**

Extend `describe("maybeAutoCreateTicketFromNotification")` in `tickets.test.ts`:

```ts
  it("force on creates even when global type is disabled", async () => {
    const withMeta = {
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    };
    // First select: alert rule mode on
    H.selectQueue.push([{ ticketAutoCreate: "on" }]);
    // Then createTicketFromNotification selects (notif, existing ticket?, max number)
    H.selectQueue.push([
      {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
      },
    ]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 0 }]);
    H.insertReturning.push([{ id: "auto-ticket", number: 1 }]);

    await maybeAutoCreateTicketFromNotification(withMeta);

    expect(H.transaction).toHaveBeenCalledTimes(1);
  });

  it("force off skips even when global type is enabled", async () => {
    H.selectQueue.push([{ ticketAutoCreate: "off" }]);
    await maybeAutoCreateTicketFromNotification({
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    });
    expect(H.transaction).not.toHaveBeenCalled();
  });

  it("inherit uses global type toggle", async () => {
    H.selectQueue.push([{ ticketAutoCreate: "inherit" }]);
    H.selectQueue.push([{ enabled: true }]);
    H.selectQueue.push([
      {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
      },
    ]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 0 }]);
    H.insertReturning.push([{ id: "auto-ticket", number: 2 }]);

    await maybeAutoCreateTicketFromNotification({
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    });
    expect(H.transaction).toHaveBeenCalledTimes(1);
  });
```

Adjust select-queue order to match the implementer’s query order (document actual order in the report). Prefer: (1) rule by id if `alertRuleId` present, (2) global type if inherit/missing, (3) createTicket selects.

Keep existing “no-ops when type not enabled” test (no meta → global select only).

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/tickets.test.ts --run
```

- [ ] **Step 3: Implement resolution**

In `tickets.ts`, import `alertRules`. Replace `maybeAutoCreateTicketFromNotification`:

```ts
function alertRuleIdFromMeta(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  const v = meta?.alertRuleId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function maybeAutoCreateTicketFromNotification(row: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  assetId: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    let mode: "inherit" | "on" | "off" = "inherit";
    const ruleId = alertRuleIdFromMeta(row.meta);
    if (ruleId) {
      const [rule] = await db
        .select({ ticketAutoCreate: alertRules.ticketAutoCreate })
        .from(alertRules)
        .where(eq(alertRules.id, ruleId))
        .limit(1);
      if (rule?.ticketAutoCreate === "on" || rule?.ticketAutoCreate === "off") {
        mode = rule.ticketAutoCreate;
      }
    }

    if (mode === "off") return;
    if (mode === "inherit") {
      const [cfg] = await db
        .select()
        .from(ticketAutoCreateTypes)
        .where(eq(ticketAutoCreateTypes.type, row.type))
        .limit(1);
      if (!cfg?.enabled) return;
    }
    // mode === "on" or inherit with enabled type
    await createTicketFromNotification(row.id, "system:auto");
  } catch (e) {
    console.error(`[tickets] auto-create failed (${row.id}):`, e);
  }
}
```

In `notifications.ts`, pass meta:

```ts
      await maybeAutoCreateTicketFromNotification({
        id: row.id,
        type: row.type as NotificationType,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
        meta: (row.meta as Record<string, unknown> | null) ?? null,
      });
```

- [ ] **Step 4: Run — expect PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/tickets.test.ts src/db/notifications.test.ts --run
```

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/tickets.ts web/src/db/tickets.test.ts web/src/db/notifications.ts
git commit -m @"
feat(spec 33): resolve ticket auto-create from alert rule override

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Stamp `alertRuleId` on metric notifications

**Files:**
- Modify: `web/src/db/alert-rules.ts` (`createNotification` call sites in evaluate loop)

- [ ] **Step 1: Add meta to fire/recover**

Where `createNotification` is called for metric-threshold / metric-recovered, add:

```ts
            meta: { alertRuleId: rule.id },
```

- [ ] **Step 2: Add/extend unit test if evaluate is tested**

If there is an existing alert-rules DB test that mocks `createNotification`, assert `meta.alertRuleId` is passed. Otherwise add a focused test or skip with note in report that call-site review covers it.

Search: `web/src/db/alert-rules` tests — if none for evaluate, a lightweight mock test is preferred:

```ts
// In alert-rules test or new case: when fire action runs, createNotification called with meta.alertRuleId
```

If evaluate is hard to unit-test without heavy harness, document call-site change in report and rely on Task 2 integration of meta.

- [ ] **Step 3: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/alert-rules.ts
# + test file if added
git commit -m @"
feat(spec 33): attach alertRuleId to metric notification meta

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Admin UI — dialog + table column

**Files:**
- Modify: `web/src/components/alert-rule-form-dialog.tsx`
- Modify: `web/src/components/alert-rules-table.tsx`
- Modify: `web/src/components/alert-rules-table.test.tsx`

- [ ] **Step 1: Form field**

In `valuesFrom` / `EMPTY` (already default inherit):

```ts
    ticketAutoCreate: rule.ticketAutoCreate,
```

Add a Select after severity:

```tsx
          <div className="grid gap-2">
            <label className="text-sm font-medium">Ticket auto-create</label>
            <Select
              value={values.ticketAutoCreate}
              onValueChange={(v) =>
                set("ticketAutoCreate", v as AlertRuleFormValues["ticketAutoCreate"])
              }
            >
              <SelectTrigger aria-invalid={!!errors.ticketAutoCreate}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TICKET_AUTO_CREATE_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {TICKET_AUTO_CREATE_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Inherit follows Admin → Ticket auto-create for metric notification types.
            </p>
            {errors.ticketAutoCreate ? (
              <p className="text-destructive text-xs">{errors.ticketAutoCreate}</p>
            ) : null}
          </div>
```

Import `TICKET_AUTO_CREATE_MODES` from schema and `TICKET_AUTO_CREATE_LABEL` from alert-rules. Match existing Select patterns in this file (Nova/Base UI `render=` if used).

- [ ] **Step 2: Table column**

Add header **Auto-create** and cell `TICKET_AUTO_CREATE_LABEL[rule.ticketAutoCreate]`.

- [ ] **Step 3: Update table tests**

Expect “Inherit” (or label) visible for fixture rules with `ticketAutoCreate: "inherit"`.

- [ ] **Step 4: Run UI tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/components/alert-rules-table.test.tsx src/lib/alert-rule-schema.test.ts --run
```

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/components/alert-rule-form-dialog.tsx web/src/components/alert-rules-table.tsx web/src/components/alert-rules-table.test.tsx
git commit -m @"
feat(spec 33): alert-rules UI for ticket auto-create override

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 5: Docs + PROGRESS

**Files:**
- Modify: `docs/specs/33-ticketing/index.md` — mark per-alert-rule override shipped; v2 complete
- Modify: `docs/specs/30-alert-rules/index.md` — note ticket auto-create override field (short)
- Modify: `PROGRESS.md`
- Modify: design Status → implemented

- [ ] **Step 1: Spec 33 phases**

```md
2. **v2** — waiting status; CSV export; simple SLA; **per-alert-rule ticket
   auto-create override** (shipped).
```

- [ ] **Step 2: PROGRESS**

Note branch + **needs `npm run db:push`**.

- [ ] **Step 3: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add docs/specs/33-ticketing/index.md docs/specs/30-alert-rules/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-alert-rule-ticket-auto-create-design.md
git commit -m @"
docs(spec 33): mark alert-rule ticket auto-create override shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage

| AC | Task |
|---|---|
| AC-O1 column + default | Task 1 |
| AC-O2 meta.alertRuleId | Task 3 |
| AC-O3 force on | Task 2 |
| AC-O4 force off | Task 2 |
| AC-O5 inherit | Task 2 |
| AC-O6 no rule id | Task 2 (existing + no meta) |
| AC-O7 admin UI | Task 4 |
| AC-O8 best-effort | Task 2 (try/catch preserved) |

## Placeholder scan

None.

## Type consistency

`TicketAutoCreateMode` / `ticketAutoCreate` field names consistent across schema, record, Zod, form, and resolution.
