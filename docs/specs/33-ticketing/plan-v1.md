# Spec 33 v1 — Ticketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship internal IT tickets (CRUD + comments), create-from-notification with dedupe, and admin-configurable auto-create by notification type, with a mock-guided `/tickets` UI gated on `user:admin`.

**Architecture:** First-class `tickets` / `ticket_comments` / `ticket_auto_create_types` in the web DB. Data layer in `db/tickets.ts`. After a successful `createNotification` insert, best-effort auto-create when the type is enabled. UI: `/tickets` master–detail; notification “Create ticket”; admin toggles on `/admin`.

**Tech Stack:** Next.js 16 App Router, Drizzle/Postgres, Vitest, existing Spec 19 notifications + shadcn/Base UI patterns, design mock `docs/Design/ticketing-mock.png`.

**Design:** [design-v1.md](./design-v1.md) · **Spec:** [index.md](./index.md)

## Global Constraints

- Branch from `main` as `feat/spec-33-ticketing-v1` before application code (docs may already live on `docs/spec-33-ticketing` — merge/rebase as needed; never commit feature code on `main`).
- `user:admin` only for all ticket surfaces and settings. No new RBAC permission in v1.
- No SLA columns, AI triage UI, email-in, or end-user portal.
- Auto-create is best-effort and must never fail `createNotification`.
- Dedupe: at most one ticket per `source_notification_id`.
- Default auto-create: **all types off** until an admin enables them.
- Mock guides layout; strip SLA / Auto-triage / AI / Export / KPI strip for v1.
- User runs `npm run db:push` / servers; agent provides commands.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Shell is PowerShell; quote paths with `(app)`.

---

## File map

| File | Responsibility |
|---|---|
| `web/src/db/schema.ts` | `tickets`, `ticketComments`, `ticketAutoCreateTypes` |
| `web/src/lib/data.ts` | Ticket DTOs + nav Ticketing item |
| `web/src/db/tickets.ts` | CRUD, comments, create-from-notification, auto-create settings + hook |
| `web/src/db/tickets.test.ts` | Unit tests (mocked DB) |
| `web/src/db/notifications.ts` | Call auto-create after successful insert |
| `web/src/app/(app)/ticket-actions.ts` | Server Actions gated `user:admin` |
| `web/src/app/(app)/tickets/page.tsx` | RSC page |
| `web/src/components/tickets-view.tsx` | List + detail pane + New Ticket |
| `web/src/components/notification-bell.tsx` (and/or notifications-view) | Create ticket / link |
| `web/src/app/(app)/admin/page.tsx` + ticket auto-create toggles component | Type matrix |
| `docs/specs/33-ticketing/*` | Status updates when shipping |

---

### Task 1: Schema + shared types

**Files:**
- Modify: `web/src/db/schema.ts`
- Modify: `web/src/lib/data.ts` (types + `NAV_MANAGE`)

**Interfaces:**
- Produces: Drizzle tables `tickets`, `ticketComments`, `ticketAutoCreateTypes`; TS types `TicketStatus`, `TicketPriority`, `TicketListItem`

- [x] **Step 1: Add schema tables**

Append near other feature tables in `web/src/db/schema.ts` (import `notifications` already exists in file):

```ts
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().unique(),
    subject: text("subject").notNull(),
    description: text("description").notNull().default(""),
    status: text("status")
      .$type<"open" | "in_progress" | "resolved" | "closed">()
      .notNull()
      .default("open"),
    priority: text("priority")
      .$type<"low" | "medium" | "high">()
      .notNull()
      .default("medium"),
    category: text("category").notNull().default(""),
    assigneeEmail: text("assignee_email"),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    sourceNotificationId: uuid("source_notification_id").references(
      () => notifications.id,
      { onDelete: "set null" },
    ),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("tickets_source_notification_id_uidx").on(t.sourceNotificationId),
    index("tickets_status_updated_idx").on(t.status, t.updatedAt),
    index("tickets_asset_id_idx").on(t.assetId),
  ],
);

export const ticketComments = pgTable("ticket_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  authorEmail: text("author_email").notNull(),
  body: text("body").notNull(),
  kind: text("kind").$type<"user" | "system">().notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Absent type = auto-create OFF (explicit enable required). */
export const ticketAutoCreateTypes = pgTable("ticket_auto_create_types", {
  type: text("type").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

Add matching `export type TicketRow = …` aliases with the other row types.

Ensure `integer` and `uniqueIndex` / `index` are imported from `drizzle-orm/pg-core` if not already.

- [x] **Step 2: Add client-safe types + nav**

In `web/src/lib/data.ts`:

```ts
export type TicketStatus =
  | "open"
  | "in_progress"
  | "waiting_on_user"
  | "resolved"
  | "closed";
export type TicketPriority = "low" | "medium" | "high";

export interface TicketListItem {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: string;
  assigneeEmail: string | null;
  assetId: string | null;
  assetTag: string | null;
  assetName: string | null;
  sourceNotificationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketCommentItem {
  id: string;
  authorEmail: string;
  body: string;
  kind: "user" | "system";
  createdAt: string;
}
```

In `NAV_MANAGE`, after Notifications (or near Compliance), add:

```ts
{ label: "Ticketing", href: "/tickets", icon: Ticket, perm: "user:admin" },
```

Import `Ticket` from `lucide-react`.

- [x] **Step 3: Commit**

```powershell
git add web/src/db/schema.ts web/src/lib/data.ts
git commit -m @"
feat(spec 33): schema and types for tickets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

Note for human: `cd web; npm run db:push` before runtime testing.

---

### Task 2: Tickets data layer

**Files:**
- Create: `web/src/db/tickets.ts`
- Create: `web/src/db/tickets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  createTicket(input: {
    subject: string;
    description?: string;
    priority?: TicketPriority;
    category?: string;
    assigneeEmail?: string | null;
    assetId?: string | null;
    sourceNotificationId?: string | null;
    createdBy: string;
  }): Promise<{ id: string; number: number } | { existingId: string }>

  listTickets(filters?: {
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: string;
    assigneeEmail?: string;
    q?: string;
  }): Promise<TicketListItem[]>

  getTicket(id: string): Promise<(TicketListItem & { comments: TicketCommentItem[] }) | null>

  updateTicket(id: string, patch: Partial<{
    subject: string;
    description: string;
    status: TicketStatus;
    priority: TicketPriority;
    category: string;
    assigneeEmail: string | null;
    assetId: string | null;
  }>): Promise<boolean>

  addTicketComment(ticketId: string, input: {
    authorEmail: string;
    body: string;
    kind?: "user" | "system";
  }): Promise<string | null>

  createTicketFromNotification(notificationId: string, createdBy: string): Promise<{ id: string; number: number } | { existingId: string } | null>

  listTicketAutoCreateTypes(): Promise<{ type: NotificationType; enabled: boolean }[]>
  setTicketAutoCreateType(type: NotificationType, enabled: boolean): Promise<void>
  maybeAutoCreateTicketFromNotification(row: {
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    assetId: string | null;
  }): Promise<void>
  ```

- [x] **Step 1: Write failing tests** for allocate number, create, dedupe by source notification, auto-create gate on/off, list filter.

Create `web/src/db/tickets.test.ts` with the same DB mock style as `notifications.test.ts` / `alert-rules.test.ts` (hoisted select/insert queues). Minimum cases:

1. `createTicket` inserts with next `number` and returns `{ id, number }`  
2. Second `createTicketFromNotification` same id returns `{ existingId }` without second insert  
3. `maybeAutoCreateTicketFromNotification` no-ops when type not enabled  
4. `maybeAutoCreateTicketFromNotification` creates when type enabled  

- [x] **Step 2: Run tests — expect FAIL**

```powershell
cd web; npx vitest run src/db/tickets.test.ts --reporter=dot
```

- [x] **Step 3: Implement `web/src/db/tickets.ts`**

Key behaviors:

- Next number: `select max(number)+1` inside a transaction (or serial; max+1 is fine at fleet scale).  
- `createTicket`: insert; if `sourceNotificationId` unique conflict, select existing and return `{ existingId }`. Add system comment `"Ticket created"`.  
- `createTicketFromNotification`: load notification by id; if missing return null; else `createTicket` with subject=`title`, description=`body`, assetId, sourceNotificationId, category derived from type (e.g. `metric-threshold` → `"Alert"`).  
- `maybeAutoCreateTicketFromNotification`:  
  ```ts
  const [row] = await db.select().from(ticketAutoCreateTypes).where(eq(ticketAutoCreateTypes.type, n.type)).limit(1);
  if (!row?.enabled) return;
  await createTicketFromNotification(n.id, "system:auto");
  ```
  Wrap in try/catch; log errors; never throw.  
- `listTicketAutoCreateTypes`: join against the known `NotificationType` union list in code (export `ALL_NOTIFICATION_TYPES` from `data.ts` or tickets.ts); enabled only if row exists with `enabled=true`.  
- `setTicketAutoCreateType`: upsert row; if `enabled=false`, either delete row or set enabled false (prefer upsert with enabled flag).

- [x] **Step 4: Run tests — expect PASS**

```powershell
cd web; npx vitest run src/db/tickets.test.ts --reporter=dot
```

- [x] **Step 5: Commit**

```powershell
git add web/src/db/tickets.ts web/src/db/tickets.test.ts
git commit -m @"
feat(spec 33): tickets data layer with notification dedupe and auto-create

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Hook auto-create into `createNotification`

**Files:**
- Modify: `web/src/db/notifications.ts`
- Modify: `web/src/db/notifications.test.ts` (mock tickets module; assert call on insert)

**Interfaces:**
- Consumes: `maybeAutoCreateTicketFromNotification`
- Produces: notifications that successfully insert may spawn tickets

- [x] **Step 1: Failing test** — after successful createNotification insert, `maybeAutoCreateTicketFromNotification` is awaited with the new row id/type/title/body/assetId. On conflict no-op (existing dedupe), it must **not** call auto-create.

- [x] **Step 2: Implement**

In `createNotification`, after `publishNotification` and before `return row.id`:

```ts
try {
  const { maybeAutoCreateTicketFromNotification } = await import("./tickets");
  await maybeAutoCreateTicketFromNotification({
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    assetId: row.assetId,
  });
} catch (e) {
  console.error(`[notifications] ticket auto-create failed (${row.id}):`, e);
}
```

Dynamic import avoids circular init if tickets ever imports notifications helpers.

- [x] **Step 3: Tests PASS + commit**

```powershell
cd web; npx vitest run src/db/notifications.test.ts src/db/tickets.test.ts --reporter=dot
git add web/src/db/notifications.ts web/src/db/notifications.test.ts
git commit -m @"
feat(spec 33): auto-create tickets from notifications when enabled

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Server actions + `/tickets` page shell

**Files:**
- Create: `web/src/app/(app)/ticket-actions.ts`
- Create: `web/src/app/(app)/tickets/page.tsx`
- Modify: `web/src/components/app-sidebar.test.tsx` / `command-palette.test.tsx` if nav assertions need Ticketing for admin

**Interfaces:**
- Actions: `createTicketAction`, `updateTicketAction`, `addTicketCommentAction`, `createTicketFromNotificationAction`, `setTicketAutoCreateTypeAction` — all require session + `user:admin`.

- [x] **Step 1: Implement actions** mirroring `alert-rule-actions.ts` / `notification-actions.ts` patterns (`getUser`, `hasPermission`, `revalidatePath`).

- [x] **Step 2: Page**

```tsx
// web/src/app/(app)/tickets/page.tsx
export default async function TicketsPage() {
  const user = await requireUser(); // or project equivalent
  if (!hasPermission(user, "user:admin")) return <Forbidden…>;
  const tickets = await listTickets();
  return <TicketsView initialTickets={tickets} viewerEmail={user.email} />;
}
```

Use the same auth helper other admin pages use (`getUser` + early return). Match `admin/alert-rules/page.tsx`.

- [x] **Step 3: Stub `TicketsView`** that renders title “Tickets”, subtitle without AI claim, and a simple list (full UI in Task 5) so the route compiles.

- [x] **Step 4: Commit**

```powershell
git add web/src/app/(app)/ticket-actions.ts "web/src/app/(app)/tickets/page.tsx" web/src/components/tickets-view.tsx web/src/components/app-sidebar.test.tsx web/src/components/command-palette.test.tsx
git commit -m @"
feat(spec 33): ticket server actions and /tickets page shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 5: Tickets UI (mock-guided, v1-cut)

**Files:**
- Modify: `web/src/components/tickets-view.tsx`
- Optional: `web/src/components/ticket-detail-pane.tsx`, `new-ticket-dialog.tsx`
- Test: light component test for filter rendering / empty state if the repo pattern warrants it

**Interfaces:**
- Consumes: `TicketListItem`, ticket actions from Task 4

- [x] **Step 1: Build UI** matching mock structure without parked chrome:

  - Header: “Tickets” + short subtitle (“Service tickets linked to assets and alerts.”)  
  - Primary button **New Ticket**  
  - Search + selects: Status, Priority, Category, Assignee  
  - Table columns: Ticket (`TKT-{number}`), Subject, Asset, Category, Priority, Status, Assignee  
  - Row select → right pane: metadata grid, description, comments timeline, add comment, status/priority/assignee editors  
  - **Do not** render SLA, KPI cards, Auto-triage, AI Triage, Export  

  Follow existing table/dialog patterns (`asset-table`, `alert-rules-table`, Base UI `render=` triggers).

- [x] **Step 2: Wire New Ticket dialog** to `createTicketAction`; detail updates to `updateTicketAction` / `addTicketCommentAction`.

- [x] **Step 3: Manual smoke note** in commit body; run any new component tests.

- [x] **Step 4: Commit**

```powershell
git add web/src/components/tickets-view.tsx web/src/components/ticket-*.tsx
git commit -m @"
feat(spec 33): tickets list and detail UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 6: Notification “Create ticket” + admin auto-create toggles

**Files:**
- Modify: `web/src/components/notification-bell.tsx` and/or `notifications-view.tsx`
- Modify: `web/src/app/(app)/admin/page.tsx`
- Create: `web/src/components/ticket-auto-create-toggles.tsx`
- Tests: update notification UI tests if they snapshot actions

- [x] **Step 1: Notification UX**

For each notification item when viewer is admin:

- If a ticket already exists for `notification.id`, show link “View ticket” → `/tickets?id=…` (pass map from server: `ticketIdByNotificationId` loaded via query on `tickets.source_notification_id`).  
- Else show **Create ticket** calling `createTicketFromNotificationAction`.

Simplest v1 approach: on `/notifications` page and bell panel fetch, join tickets; or lazy action that returns existing. Prefer loading a `Map` in the notifications page RSC; for the bell, after create toast + navigate.

- [x] **Step 2: Admin toggles**

On `/admin` (user:admin section), card **Ticket auto-create** listing each `NotificationType` with a Switch. Bound to `listTicketAutoCreateTypes` / `setTicketAutoCreateTypeAction`. Default all off.

- [x] **Step 3: Tests + commit**

```powershell
cd web; npx vitest run src/db/tickets.test.ts src/db/notifications.test.ts --reporter=dot
git add web/src/components/notification-bell.tsx web/src/components/notifications-view.tsx web/src/components/ticket-auto-create-toggles.tsx "web/src/app/(app)/admin/page.tsx"
git commit -m @"
feat(spec 33): create ticket from notifications and admin auto-create toggles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 7: Docs + ship checklist

**Files:**
- Modify: `docs/specs/33-ticketing/index.md` (Status → implementing / shipped as appropriate)
- Modify: `docs/specs/33-ticketing/design-v1.md`
- Modify: `docs/specs/33-ticketing/plan-v1.md` checkboxes when executing

- [x] **Step 1:** Mark status **Accepted (implementing on `feat/spec-33-ticketing-v1`)** at start of coding; after merge **shipped**.

- [x] **Step 2: Commit docs** with the feature branch (or docs-only commit at end).

- [ ] **Step 3: Manual verify (user)**

1. `npm run db:push`  
2. Admin opens `/tickets`, creates a ticket, comments, changes status  
3. Create ticket from a notification; second click returns same ticket  
4. Enable `printer-down` (or similar) auto-create; trigger alert → ticket appears  
5. Non-admin cannot open `/tickets`

---

## Spec coverage (self-review)

| AC | Task |
|---|---|
| AC-1 schema fields | Task 1–2 |
| AC-2 comments user/system | Task 2, 5 |
| AC-3 admin CRUD gate | Task 4–5 |
| AC-4 manual + from notification dedupe | Task 2, 5–6 |
| AC-5 auto-create settings + hook | Task 2–3, 6 |
| AC-6 UI mock-cut | Task 5 |
| AC-7 nav + deep links | Task 1, 4–6 |

No placeholders for required behaviors. UI component internals may follow existing table patterns where this plan specifies structure and fields rather than every JSX line.
