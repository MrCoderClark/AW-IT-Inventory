import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSoftwareTitleDetail } from "@/db/software";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function fmtDay(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export default async function Page({
  params,
}: PageProps<"/software/[trackedId]">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Software"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { trackedId } = await params;
  const detail = await getSoftwareTitleDetail(trackedId);
  if (!detail) notFound();

  const { title, machines } = detail;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <Link
        href="/software"
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to software
      </Link>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tracked software
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{title.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Installed on {machines.length} computer
          {machines.length === 1 ? "" : "s"}.
        </p>
      </div>

      {machines.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
          No computers have this title yet. It appears here once a Windows scan of
          a managed computer finds a program whose name contains{" "}
          <span className="font-mono">{title.name}</span>.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Computer</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Versions</TableHead>
                <TableHead className="w-[140px]">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link
                      href={`/assets/${m.id}`}
                      className="font-medium hover:underline"
                    >
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {m.serial || "—"}
                  </TableCell>
                  <TableCell>
                    {m.versions.length === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {m.versions.map((v) => (
                          <Badge key={v} variant="secondary" className="font-mono">
                            {v}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    {fmtDay(m.lastSeen)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
