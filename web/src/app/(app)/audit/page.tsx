import { Lock } from "lucide-react";

import {
  AuditLogView,
  type AuditRange,
} from "@/components/audit-log-view";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAuditKpis, listAuditEvents } from "@/db/computer-audit";
import { getLocationOptions } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The log changes with every job. Read it fresh, including the filter query.
export const dynamic = "force-dynamic";

const RANGES = ["today", "7", "30", "90"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

function clip(value: string): string {
  return value.slice(0, 200);
}

function parseRange(value: string): AuditRange {
  return (RANGES as readonly string[]).includes(value)
    ? (value as AuditRange)
    : "30";
}

/** `30` omits `from` so the list helper's own last-30-days window applies. */
function fromForRange(range: AuditRange): Date | undefined {
  if (range === "30") return undefined;
  if (range === "today") {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  const days = range === "7" ? 7 : 90;
  return new Date(Date.now() - days * DAY_MS);
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    asset?: SearchValue;
    action?: SearchValue;
    operator?: SearchValue;
    range?: SearchValue;
    loc?: SearchValue;
  }>;
}) {
  const user = await requireUser();

  if (!hasPermission(user, "audit:read")) {
    return (
      <PagePlaceholder
        title="Audit log"
        description="You don't have permission to view the audit log. Ask an administrator for the audit:read role."
        icon={Lock}
      />
    );
  }

  const sp = await searchParams;
  const range = parseRange(first(sp.range));
  const loc = first(sp.loc);
  const locationId = UUID_RE.test(loc) ? loc : "";
  const from = fromForRange(range);

  const [events, kpis, locations] = await Promise.all([
    listAuditEvents({
      from,
      locationId: locationId || undefined,
    }),
    getAuditKpis({
      from,
      locationId: locationId || undefined,
    }),
    getLocationOptions(),
  ]);

  return (
    <AuditLogView
      key={`${range}:${locationId}`}
      events={events}
      kpis={kpis}
      locations={locations.map((locOption) => ({
        id: locOption.id,
        path: locOption.path,
      }))}
      filters={{
        asset: clip(first(sp.asset)),
        action: clip(first(sp.action)),
        operator: clip(first(sp.operator)),
        range,
        locationId,
      }}
    />
  );
}
