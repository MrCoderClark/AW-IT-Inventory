import { Lock, ShieldCheck } from "lucide-react";

import { ComplianceFleet, type FleetRow } from "@/components/compliance-fleet";
import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { Card } from "@/components/ui/card";
import { getFleetCompliance } from "@/db/compliance";
import {
  scoreCompliance,
  type CheckId,
  type CompliancePosture,
} from "@/lib/compliance-score";
import { hasPermission, requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

/** All-unknown posture: used to render a never-scanned computer as "Not assessed"
   with the same check shape as a scanned-but-unreadable one. */
const EMPTY_POSTURE: CompliancePosture = {
  bitlocker: null,
  defenderRealtime: null,
  defenderSigAgeDays: null,
  avProduct: null,
  tpmReady: null,
  secureBoot: null,
  updatesLastDays: null,
  updatesPending: null,
  systemDrivePctUsed: null,
};

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
      {hint && <span className="mt-1 text-xs text-muted-foreground">{hint}</span>}
    </Card>
  );
}

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user, like /reports and /software.
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Compliance"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const fleet = await getFleetCompliance();
  const rows: FleetRow[] = fleet.map((f) => {
    const s = scoreCompliance(f.posture ?? EMPTY_POSTURE);
    return {
      tag: f.tag,
      name: f.name,
      score: s.score,
      assessed: s.assessed,
      checks: s.checks.map((c) => ({ id: c.id, label: c.label, status: c.status })),
    };
  });

  const total = rows.length;
  const assessed = rows.filter((r) => r.assessed);
  const notAssessed = total - assessed.length;
  const avg = assessed.length
    ? Math.round(assessed.reduce((s, r) => s + (r.score ?? 0), 0) / assessed.length)
    : null;
  const passCount = (id: CheckId) =>
    rows.filter((r) => r.checks.find((c) => c.id === id)?.status === "pass").length;
  const failCount = (id: CheckId) =>
    rows.filter((r) => r.checks.find((c) => c.id === id)?.status === "fail").length;

  const bitlockerOn = passCount("bitlocker");
  const avHealthy = passCount("antivirus");
  const updatesBehind = failCount("updates");

  const avgTone =
    avg == null ? "muted" : avg >= 80 ? "good" : avg >= 50 ? "warn" : "danger";

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <HeroHeader
        title="Compliance"
        subtitle="Security posture and a health score for every managed computer — live from collector scans."
        icon={<ShieldCheck />}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Average score"
          value={avg == null ? "—" : `${avg}`}
          tone={avgTone}
          hint={`across ${assessed.length} assessed`}
        />
        <StatTile
          label="BitLocker on"
          value={`${bitlockerOn} / ${total}`}
          tone={bitlockerOn === total && total > 0 ? "good" : "default"}
          hint="encrypted"
        />
        <StatTile
          label="Antivirus healthy"
          value={`${avHealthy} / ${total}`}
          tone={avHealthy === total && total > 0 ? "good" : "default"}
          hint="real-time on"
        />
        <StatTile
          label="Updates 30+ days behind"
          value={updatesBehind}
          tone={updatesBehind > 0 ? "danger" : "good"}
        />
        <StatTile
          label="Not assessed"
          value={notAssessed}
          tone={notAssessed > 0 ? "warn" : "muted"}
          hint="need remote admin"
        />
      </section>

      <ComplianceFleet rows={rows} />
    </div>
  );
}
