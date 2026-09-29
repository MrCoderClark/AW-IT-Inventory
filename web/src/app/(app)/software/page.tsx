import Link from "next/link";
import { AppWindow, ChevronRight, Lock } from "lucide-react";

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
import { getSoftwareInventory } from "@/db/software";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The watchlist and its matches change on each scan or admin edit; read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user (spec 15, AC-4).
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Software"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const rows = await getSoftwareInventory();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Software</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tracked software titles across the fleet: how many computers have each,
          and which versions are out there. Manage the watchlist on the Admin page.
        </p>
      </div>

      {rows.length === 0 ? (
        <PagePlaceholder
          title="No software tracked yet"
          description="Add titles to the watchlist on the Admin page. Once a Windows scan runs, each tracked title shows here with its fleet count and versions."
          icon={AppWindow}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead className="w-[120px] text-right">Computers</TableHead>
                <TableHead>Versions</TableHead>
                <TableHead className="w-[40px]" aria-label="Open" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
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
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {r.versions.map((v) => (
                          <Badge key={v} variant="secondary" className="font-mono">
                            {v}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/software/${r.id}`}
                      aria-label={`View computers with ${r.name}`}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
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
