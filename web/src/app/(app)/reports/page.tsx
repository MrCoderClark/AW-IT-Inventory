import Link from "next/link";
import {
  CalendarClock,
  FileText,
  Lock,
  PackageOpen,
  ShieldCheck,
  Users,
} from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getAgingReport,
  getAssignmentSummary,
  getWarrantyReport,
  type WarrantyBucket,
} from "@/db/reports";
import { getSoftwareInventory } from "@/db/software";
import { TYPE_ICON } from "@/lib/data";
import { cn } from "@/lib/utils";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Reports read live from the fleet (warranty dates, assignments, scans change
// constantly); never serve a stale snapshot.
export const dynamic = "force-dynamic";

/* ---------------- Small presentational helpers ---------------- */

/** A compact labelled number tile for the summary row above each report. The
   optional `tone` tints the value (e.g. red for expired, amber for soon). */
function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "default" | "danger" | "warn" | "good" | "muted";
}) {
  const toneClass = {
    default: "text-foreground",
    danger: "text-destructive",
    warn: "text-status-maintenance",
    good: "text-positive",
    muted: "text-muted-foreground",
  }[tone];
  return (
    <Card className="gap-0 p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-2 text-2xl font-extrabold tracking-tight tabular-nums",
          toneClass,
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
      {hint && (
        <span className="mt-1 text-xs text-muted-foreground">{hint}</span>
      )}
    </Card>
  );
}

function TypeCell({ type }: { type: keyof typeof TYPE_ICON }) {
  const Icon = TYPE_ICON[type];
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Icon className="size-4 text-muted-foreground" />
      {type}
    </span>
  );
}

/** An empty-state row spanning the whole table when a report has no entries. */
function EmptyRow({ span, children }: { span: number; children: string }) {
  return (
    <TableRow>
      <TableCell
        colSpan={span}
        className="py-10 text-center text-sm text-muted-foreground"
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

// Keyed by the bucket. `ok` rows never reach the table, so it is omitted; the
// lookup is `Partial` so indexing by the full union stays type-safe.
const WARRANTY_BADGE: Partial<
  Record<WarrantyBucket, { label: string; className: string }>
> = {
  expired: {
    label: "Expired",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  soon: {
    label: "≤ 30 days",
    className:
      "border-status-maintenance/30 bg-status-maintenance/10 text-status-maintenance",
  },
  upcoming: {
    label: "≤ 90 days",
    className: "border-primary/30 bg-primary/10 text-primary",
  },
};

/** "in 12 days" / "14 days ago" / "today". */
function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} ago`;
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/* ================================================================
   Page
   ================================================================ */

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user, like /software and the asset lists.
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Reports"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const [warranty, aging, assignments, software] = await Promise.all([
    getWarrantyReport(),
    getAgingReport(),
    getAssignmentSummary(),
    getSoftwareInventory(),
  ]);

  const trackedTitles = software.length;
  const totalInstalls = software.reduce((sum, r) => sum + r.machineCount, 0);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <HeroHeader
        title="Reports"
        subtitle="Warranty, asset aging, assignments and software across the fleet — live from the inventory."
        icon={<FileText />}
      />

      <Tabs defaultValue="warranty">
        <TabsList className="flex-wrap">
          <TabsTab value="warranty" className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4" /> Warranty
          </TabsTab>
          <TabsTab value="aging" className="inline-flex items-center gap-2">
            <CalendarClock className="size-4" /> Asset aging
          </TabsTab>
          <TabsTab value="assignments" className="inline-flex items-center gap-2">
            <Users className="size-4" /> Assignments
          </TabsTab>
          <TabsTab value="software" className="inline-flex items-center gap-2">
            <PackageOpen className="size-4" /> Software
          </TabsTab>
        </TabsList>

        {/* ---------------- Warranty expiry ---------------- */}
        <TabsPanel value="warranty" className="flex flex-col gap-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <StatTile
              label="Expired"
              value={warranty.counts.expired}
              tone="danger"
              hint="warranty lapsed"
            />
            <StatTile
              label="Expiring ≤ 30 days"
              value={warranty.counts.soon}
              tone="warn"
              hint="act soon"
            />
            <StatTile
              label="Expiring ≤ 90 days"
              value={warranty.counts.upcoming}
              hint="plan ahead"
            />
            <StatTile
              label="Covered"
              value={warranty.counts.ok}
              tone="good"
              hint="> 90 days left"
            />
            <StatTile
              label="No date on record"
              value={warranty.counts.unknown}
              tone="muted"
            />
          </section>

          <Card className="gap-0 p-0">
            <div className="border-b px-5 py-4">
              <h2 className="font-heading text-base font-semibold">
                Needs attention
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Every device already expired or expiring within 90 days, soonest
                first.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Warranty until</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assignee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {warranty.rows.length === 0 ? (
                  <EmptyRow span={7}>
                    Nothing expiring in the next 90 days.
                  </EmptyRow>
                ) : (
                  warranty.rows.map((r) => {
                    const badge = WARRANTY_BADGE[r.bucket];
                    return (
                      <TableRow key={r.tag} className="group">
                        <TableCell>
                          <Link
                            href={`/assets/${r.tag}`}
                            className="font-medium hover:underline"
                          >
                            {r.name}
                          </Link>
                          <div className="font-mono text-xs text-muted-foreground">
                            {r.tag}
                          </div>
                        </TableCell>
                        <TableCell>
                          <TypeCell type={r.type} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.vendor || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-sm tabular-nums">
                          {r.warrantyUntil}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                              badge?.className,
                            )}
                            title={relativeDays(r.daysLeft)}
                          >
                            {relativeDays(r.daysLeft)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.assignee || (
                            <span className="text-muted-foreground">
                              Unassigned
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsPanel>

        {/* ---------------- Asset aging ---------------- */}
        <TabsPanel value="aging" className="flex flex-col gap-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <StatTile label="Under 1 year" value={aging.counts.under1} tone="good" />
            <StatTile label="1–3 years" value={aging.counts.y1to3} />
            <StatTile label="3–5 years" value={aging.counts.y3to5} tone="warn" />
            <StatTile
              label="Over 5 years"
              value={aging.counts.over5}
              tone="danger"
              hint="refresh candidates"
            />
            <StatTile
              label="No date on record"
              value={aging.counts.unknown}
              tone="muted"
            />
          </section>

          <Card className="gap-0 p-0">
            <div className="border-b px-5 py-4">
              <h2 className="font-heading text-base font-semibold">
                Oldest devices
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                The {aging.oldest.length} oldest assets by purchase date — the
                first candidates for refresh.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Purchased</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aging.oldest.length === 0 ? (
                  <EmptyRow span={7}>
                    No assets have a purchase date recorded yet.
                  </EmptyRow>
                ) : (
                  aging.oldest.map((r) => (
                    <TableRow key={r.tag} className="group">
                      <TableCell>
                        <Link
                          href={`/assets/${r.tag}`}
                          className="font-medium hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">
                          {r.tag}
                        </div>
                      </TableCell>
                      <TableCell>
                        <TypeCell type={r.type} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.vendor || "—"}
                      </TableCell>
                      <TableCell className="font-mono text-sm tabular-nums">
                        {r.purchaseDate}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {r.ageYears === 0
                          ? "< 1 yr"
                          : `${r.ageYears} yr${r.ageYears === 1 ? "" : "s"}`}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.location || "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsPanel>

        {/* ---------------- Assignments ---------------- */}
        <TabsPanel value="assignments" className="flex flex-col gap-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total assets" value={assignments.total} />
            <StatTile
              label="Assigned"
              value={assignments.assigned}
              tone="good"
            />
            <StatTile
              label="In the pool"
              value={assignments.unassigned}
              tone="muted"
              hint="unassigned"
            />
            <StatTile
              label="People with devices"
              value={assignments.peopleWithDevices}
            />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 p-0">
              <div className="border-b px-5 py-4">
                <h2 className="font-heading text-base font-semibold">
                  Assigned vs. pool by type
                </h2>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Assigned</TableHead>
                    <TableHead className="text-right">Pool</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.byType.length === 0 ? (
                    <EmptyRow span={4}>No assets yet.</EmptyRow>
                  ) : (
                    assignments.byType.map((r) => (
                      <TableRow key={r.type}>
                        <TableCell>
                          <TypeCell type={r.type} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.assigned}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {r.unassigned}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {r.total}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>

            <Card className="gap-0 p-0">
              <div className="border-b px-5 py-4">
                <h2 className="font-heading text-base font-semibold">
                  Top device holders
                </h2>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead className="text-right">Devices</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.topHolders.length === 0 ? (
                    <EmptyRow span={3}>No devices are assigned yet.</EmptyRow>
                  ) : (
                    assignments.topHolders.map((h) => (
                      <TableRow key={h.id} className="group">
                        <TableCell>
                          <Link
                            href={`/people/${h.id}`}
                            className="font-medium hover:underline"
                          >
                            {h.name}
                          </Link>
                          {h.jobTitle && (
                            <div className="text-xs text-muted-foreground">
                              {h.jobTitle}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {h.department || "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {h.deviceCount}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </div>
        </TabsPanel>

        {/* ---------------- Software ---------------- */}
        <TabsPanel value="software" className="flex flex-col gap-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Tracked titles" value={trackedTitles} />
            <StatTile
              label="Total installs"
              value={totalInstalls}
              hint="across all computers"
            />
            <StatTile
              label="Titles not found"
              value={software.filter((r) => r.machineCount === 0).length}
              tone="muted"
              hint="on no computer"
            />
          </section>

          <Card className="gap-0 p-0">
            <div className="border-b px-5 py-4">
              <h2 className="font-heading text-base font-semibold">
                Tracked software
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Each watchlist title, how many computers have it, and the
                versions in the wild. Manage the watchlist on the Admin page.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="text-right">Computers</TableHead>
                  <TableHead>Versions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {software.length === 0 ? (
                  <EmptyRow span={3}>
                    No software tracked yet — add titles on the Admin page.
                  </EmptyRow>
                ) : (
                  software.map((r) => (
                    <TableRow key={r.id} className="group">
                      <TableCell>
                        <Link
                          href={`/software/${r.id}`}
                          className="font-medium hover:underline"
                        >
                          {r.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {r.machineCount === 0 ? (
                          <span className="text-muted-foreground">0</span>
                        ) : (
                          r.machineCount
                        )}
                      </TableCell>
                      <TableCell>
                        {r.versions.length === 0 ? (
                          <span className="text-sm text-muted-foreground">
                            —
                          </span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {r.versions.map((v) => (
                              <Badge
                                key={v}
                                variant="secondary"
                                className="font-mono"
                              >
                                {v}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
