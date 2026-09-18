import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Lock, MapPin, Settings2 } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import {
  getAssets,
  getLocationById,
  getLocationOptions,
  getPeople,
} from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";
import { LOCATION_PATH_SEP } from "@/lib/data";

export default async function Page({ params }: PageProps<"/locations/[id]">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Location"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await params;
  const location = await getLocationById(id);
  if (!location) notFound();

  const canWrite = hasPermission(user, "asset:write");
  const [assets, options, people] = await Promise.all([
    // Everything assigned anywhere in this location's subtree (AC-8).
    getAssets({ locationId: id }),
    getLocationOptions(),
    canWrite ? getPeople() : Promise.resolve([]),
  ]);

  const current = options.find((o) => o.id === id);
  const path = current?.path ?? location.name;
  const parts = path.split(LOCATION_PATH_SEP);
  const children = options.filter((o) => o.parentId === id);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/locations" className="hover:text-foreground">
            Locations
          </Link>
          {parts.map((part, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <ChevronRight className="size-3.5" />
              <span className={i === parts.length - 1 ? "text-foreground" : ""}>
                {part}
              </span>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-accent text-primary">
              <MapPin className="size-5" />
            </span>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">
                {location.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {assets.length} device{assets.length === 1 ? "" : "s"} in this
                location{children.length > 0 ? " and everything under it" : ""}.
              </p>
            </div>
          </div>
          <Link
            href="/locations"
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Settings2 className="size-4" /> Manage locations
          </Link>
        </div>

        {children.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sublocations
            </span>
            {children.map((child) => (
              <Link
                key={child.id}
                href={`/locations/${child.id}`}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <MapPin className="size-3.5 text-muted-foreground" />
                {child.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <AssetTable
        assets={assets}
        config={{
          showTypeFilter: true,
          showLocationFilter: false,
          emptyMessage: "No devices assigned to this location yet.",
        }}
        canWrite={canWrite}
        people={people}
        locations={options}
      />
    </div>
  );
}
