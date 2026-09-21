"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ColumnDef,
  type Row,
  type SortingState,
  type ColumnFiltersState,
  type RowSelectionState,
  type RowData,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  Columns3,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  QrCode,
  ScanLine,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import { requestScan } from "@/app/(app)/scan-actions";

import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/status-badge";
import { ReachabilityBadge } from "@/components/reachability-badge";
import {
  STATUS_META,
  TYPE_ICON,
  type Asset,
  type AssetStatus,
  type AssetType,
  type LocationOption,
} from "@/lib/data";
import { TYPE_FIELDS } from "@/lib/asset-fields";
import {
  resolveColumns,
  type ColumnId,
  type ColumnView,
} from "@/lib/table-columns";
import { ColumnPickerDialog } from "@/components/column-picker-dialog";
import { cn } from "@/lib/utils";

/** Map a category's asset type to its column view (spec 11). The mixed views
   (dashboard, location) are passed explicitly by their pages. */
const TYPE_TO_VIEW: Record<AssetType, ColumnView> = {
  Computer: "computer",
  Monitor: "monitor",
  Printer: "printer",
  Phone: "phone",
  Network: "network",
};

/** Whether a type is ever assigned to a person. Printers and network gear are
   shared infrastructure (the form hides Assignee for them), so on a mixed-type
   table their Assigned To cell shows "not applicable", not "Pool". */
function typeTakesAssignee(type: AssetType): boolean {
  return !TYPE_FIELDS[type].hiddenShared.includes("assigneeId");
}

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    openAsset: (id: string) => void;
  }
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

/** Lowercase and drop every separator, so a search matches regardless of
   punctuation or case (e.g. "aa-bb-cc" and "AA:BB:CC" both find the same MAC,
   and "5551234567" finds "(555) 123-4567"). Spec 10 AC-5. */
function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Everything about an asset a search should match, including the type-specific
   identifiers carried on `search` (IP, IMEI, phone, MAC). */
function assetHaystack(a: Asset): string {
  return [
    a.id,
    a.name,
    a.type,
    a.serial,
    a.model,
    a.assignee?.name,
    a.location,
    a.vendor,
    a.costCenter,
    a.spec,
    a.status,
    a.search,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Global search over the whole asset, separator- and case-insensitive. */
function assetGlobalFilter(
  row: Row<Asset>,
  _columnId: string,
  filterValue: string,
): boolean {
  const q = normalizeSearch(String(filterValue ?? ""));
  if (!q) return true;
  return normalizeSearch(assetHaystack(row.original)).includes(q);
}

function SortHeader({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="inline-flex items-center gap-1 hover:text-foreground"
      onClick={onClick}
    >
      {label}
      <ArrowUpDown className="size-3 text-primary" />
    </button>
  );
}

/* ---------------- Column definitions ----------------
   Defined once, then registered by stable id in `COLUMN_REGISTRY` below. The
   render rule (`resolveColumns`, spec 11) picks which ids show and in what order
   from the saved layout or the code defaults. */

/** Row-selection checkbox column, prepended only on the Computers table when the
   user can scan (spec 12, AC-2). Native inputs (styled) — no extra UI primitive.
   Clicks stop propagation so ticking a box never opens the asset. */
const selectColumn: ColumnDef<Asset> = {
  id: "select",
  header: ({ table }) => (
    <input
      type="checkbox"
      aria-label="Select all on this page"
      className="size-4 cursor-pointer accent-primary align-middle"
      checked={table.getIsAllPageRowsSelected()}
      onChange={(e) => table.toggleAllPageRowsSelected(e.target.checked)}
    />
  ),
  cell: ({ row }) => (
    <input
      type="checkbox"
      aria-label={`Select ${row.original.id}`}
      className="size-4 cursor-pointer accent-primary align-middle"
      checked={row.getIsSelected()}
      onChange={(e) => row.toggleSelected(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  ),
  enableSorting: false,
};

const idColumn: ColumnDef<Asset> = {
  accessorKey: "id",
  header: ({ column }) => (
    <SortHeader
      label="Asset ID"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    />
  ),
  cell: ({ row }) => (
    <span className="font-mono text-[13px] font-semibold">{row.original.id}</span>
  ),
};

const nameColumn: ColumnDef<Asset> = {
  accessorKey: "name",
  header: ({ column }) => (
    <SortHeader
      label="Asset Name"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    />
  ),
  cell: ({ row }) => {
    const Icon = TYPE_ICON[row.original.type];
    return (
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="font-medium">{row.original.name}</span>
      </div>
    );
  },
};

const typeColumn: ColumnDef<Asset> = {
  accessorKey: "type",
  header: "Type",
  cell: ({ row }) => (
    <span className="text-muted-foreground">{row.original.type}</span>
  ),
  filterFn: "equals",
};

const serialColumn: ColumnDef<Asset> = {
  accessorKey: "serial",
  header: "Serial Number",
  cell: ({ row }) => (
    <span className="font-mono text-xs text-muted-foreground">
      {row.original.serial}
    </span>
  ),
};

const modelColumn: ColumnDef<Asset> = {
  accessorKey: "model",
  header: "Model",
  cell: ({ row }) => (
    <span className="text-muted-foreground">{row.original.model}</span>
  ),
};

const assigneeColumn: ColumnDef<Asset> = {
  id: "assignee",
  accessorFn: (a) => (typeTakesAssignee(a.type) ? a.assignee?.name ?? "Pool" : ""),
  header: "Assigned To",
  cell: ({ row }) => {
    const asset = row.original;
    // Printers / network gear aren't assigned to a person.
    if (!typeTakesAssignee(asset.type)) {
      return <span className="text-muted-foreground">—</span>;
    }
    const a = asset.assignee;
    return (
      <div className="flex items-center gap-2.5">
        <Avatar className="size-7">
          <AvatarFallback
            className={cn(
              "text-[10px] font-bold",
              a
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {a ? a.initials : "··"}
          </AvatarFallback>
        </Avatar>
        <span className={cn(!a && "text-muted-foreground")}>
          {a ? a.name : "Pool"}
        </span>
      </div>
    );
  },
};

const locationColumn: ColumnDef<Asset> = {
  accessorKey: "location",
  header: "Location",
  cell: ({ row }) => (
    <span className="text-muted-foreground">{row.original.location}</span>
  ),
};

/* Type-specific identifier columns (spec 10), shown only on the category page
   for the type that has them. */

const ipColumn: ColumnDef<Asset> = {
  id: "ip",
  accessorFn: (a) => a.ip ?? "",
  header: "IP Address",
  cell: ({ row }) => (
    <span className="font-mono text-xs text-muted-foreground">
      {row.original.ip || "—"}
    </span>
  ),
};

const macColumn: ColumnDef<Asset> = {
  id: "mac",
  accessorFn: (a) => a.mac ?? "",
  header: "MAC",
  cell: ({ row }) => (
    <span className="font-mono text-xs text-muted-foreground">
      {row.original.mac || "—"}
    </span>
  ),
};

const phoneColumn: ColumnDef<Asset> = {
  id: "phoneNumber",
  accessorFn: (a) => a.phoneNumber ?? "",
  header: "Phone",
  cell: ({ row }) => (
    <span className="text-muted-foreground">
      {row.original.phoneNumber || "—"}
    </span>
  ),
};

const reachabilityColumn: ColumnDef<Asset> = {
  id: "reachability",
  accessorFn: (a) => a.reachability?.state ?? "unknown",
  header: "Reachability",
  cell: ({ row }) => (
    <ReachabilityBadge reachability={row.original.reachability} />
  ),
  filterFn: "equals",
};

const statusColumn: ColumnDef<Asset> = {
  accessorKey: "status",
  header: "Status",
  cell: ({ row }) => <StatusBadge status={row.original.status} />,
  filterFn: "equals",
};

const lastSyncColumn: ColumnDef<Asset> = {
  accessorKey: "lastSync",
  header: ({ column }) => (
    <SortHeader
      label="Last Sync"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    />
  ),
  cell: ({ row }) => (
    <span className="text-muted-foreground tabular-nums">
      {fmtDate(row.original.lastSync)}
    </span>
  ),
};

const actionsColumn: ColumnDef<Asset> = {
  id: "actions",
  header: "",
  cell: ({ row, table }) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={`Actions for ${row.original.id}`}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard?.writeText(row.original.id);
            toast.success("Asset ID copied", { description: row.original.id });
          }}
        >
          Copy asset ID
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => table.options.meta?.openAsset(row.original.id)}
        >
          View details
        </DropdownMenuItem>
        <DropdownMenuItem>Reassign</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Retire asset</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** Every column, keyed by its stable id (spec 11). The render rule in
   `resolveColumns` picks the ids and order; this maps each id to its cell. */
const COLUMN_REGISTRY: Record<ColumnId, ColumnDef<Asset>> = {
  id: idColumn,
  name: nameColumn,
  type: typeColumn,
  serial: serialColumn,
  model: modelColumn,
  assignee: assigneeColumn,
  location: locationColumn,
  status: statusColumn,
  lastSync: lastSyncColumn,
  ip: ipColumn,
  mac: macColumn,
  phoneNumber: phoneColumn,
  reachability: reachabilityColumn,
  actions: actionsColumn,
};

export type AssetTableConfig = {
  /** The category this table is scoped to. Omit for the all-types dashboard
     view. Still used for the create form's preset type and (when `view` is
     omitted) to derive the column view. */
  type?: AssetType;
  /** The configurable column view this table renders (spec 11). Defaults to the
     category's view, or `dashboard` for the mixed all-types view. */
  view?: ColumnView;
  /** The saved column layout for this view (`null` = none, use code defaults).
     Serializable so it passes from the RSC. */
  columnOrder?: string[] | null;
  showTypeFilter?: boolean;
  /** Hide the location filter (e.g. on a page already scoped to a location).
     Defaults to shown when any locations exist. */
  showLocationFilter?: boolean;
  title?: string;
  emptyMessage?: string;
};

export function AssetTable({
  assets,
  config,
  canWrite = false,
  canConfigureColumns = false,
  canScan = false,
  people = [],
  locations = [],
  activeLocationId,
}: {
  assets: Asset[];
  config: AssetTableConfig;
  /** Show the write controls (New asset) only for `asset:write` users. */
  canWrite?: boolean;
  /** Show the "Columns" picker only for `columns:write` admins (spec 11). */
  canConfigureColumns?: boolean;
  /** Show the scan controls (select + Scan selected / Scan all) only for
     `scan:write` users; the UI enables them on the Computers table (spec 12). */
  canScan?: boolean;
  /** People for the assignee picker in the create form. */
  people?: PersonOption[];
  /** The whole location tree as flat options: the filter lists all of them, the
     create form lists only the leaves. */
  locations?: LocationOption[];
  /** The location currently filtering the list (from the `loc` URL param). */
  activeLocationId?: string;
}) {
  const {
    type,
    columnOrder = null,
    showTypeFilter = false,
    showLocationFilter = true,
    title,
    emptyMessage,
  } = config;
  const view: ColumnView =
    config.view ?? (type ? TYPE_TO_VIEW[type] : "dashboard");
  // Scan controls live on the Computers table for `scan:write` users (spec 12).
  const scanEnabled = canScan && type === "Computer";
  // Resolve the column ids for this view (saved layout over code defaults), then
  // map each id to its cell. The mixed views drop Assigned To when nothing shown
  // is assigned to a person, but only when no layout is saved (spec 11).
  const resolvedIds = React.useMemo(() => {
    const anyAssignee = assets.some((a) => typeTakesAssignee(a.type));
    return resolveColumns(view, columnOrder, { anyAssignee });
  }, [view, columnOrder, assets]);
  const columns = React.useMemo(() => {
    const base = resolvedIds.map((id) => COLUMN_REGISTRY[id]);
    return scanEnabled ? [selectColumn, ...base] : base;
  }, [resolvedIds, scanEnabled]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openAsset = (id: string) =>
    router.push(`/assets/${encodeURIComponent(id)}`);

  const leafLocations = React.useMemo(
    () => locations.filter((l) => l.isLeaf),
    [locations],
  );

  // The location filter is server-driven: it narrows the fetched set to the
  // chosen location's subtree (a parent includes every descendant leaf) via the
  // `loc` URL param, so the RSC re-queries. Search / status / type stay client-side.
  function setLocationFilter(next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (!next || next === "all") params.delete("loc");
    else params.set("loc", next);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const [formOpen, setFormOpen] = React.useState(false);
  const [columnsOpen, setColumnsOpen] = React.useState(false);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [isScanning, startScan] = React.useTransition();

  const table = useReactTable({
    data: assets,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection },
    meta: { openAsset },
    getRowId: (row) => row.id,
    enableRowSelection: scanEnabled,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    globalFilterFn: assetGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  });

  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original.id);

  // Queue a scan of the ticked computers (AC-2), then clear the selection.
  function scanSelected() {
    if (selectedIds.length === 0) return;
    startScan(async () => {
      const res = await requestScan("selected", selectedIds);
      if (res.ok) {
        toast.success(res.message);
        setRowSelection({});
      } else {
        toast.error(res.error);
      }
    });
  }

  // Queue a scan of every known device — IPs snapshotted server-side (AC-2).
  function scanAll() {
    startScan(async () => {
      const res = await requestScan("all", []);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  // Only the all-types view has a `type` column; looking it up otherwise
  // makes TanStack log "Column with id 'type' does not exist". The value is
  // only used by the type filter, which shows only when that column exists.
  const typeFilter = showTypeFilter
    ? ((table.getColumn("type")?.getFilterValue() as string) ?? "all")
    : "all";
  const statusFilter =
    (table.getColumn("status")?.getFilterValue() as string) ?? "all";

  const card = (
    <div className="rounded-xl border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search assets…"
            className="pl-9"
          />
        </div>

        {showTypeFilter && (
          <Select
            value={typeFilter}
            onValueChange={(v) =>
              table.getColumn("type")?.setFilterValue(v === "all" ? undefined : v)
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Asset Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="Computer">Computer</SelectItem>
              <SelectItem value="Monitor">Monitor</SelectItem>
              <SelectItem value="Printer">Printer</SelectItem>
              <SelectItem value="Phone">Phone</SelectItem>
              <SelectItem value="Network">Network</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Select
          value={statusFilter}
          onValueChange={(v) =>
            table
              .getColumn("status")
              ?.setFilterValue(v === "all" ? undefined : v)
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {(Object.keys(STATUS_META) as AssetStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {showLocationFilter && locations.length > 0 && (
          <Select
            value={activeLocationId ?? "all"}
            onValueChange={setLocationFilter}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Locations</SelectItem>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex items-center gap-2">
          {scanEnabled && (
            <>
              <Button
                variant="outline"
                onClick={scanSelected}
                disabled={isScanning || selectedIds.length === 0}
              >
                {isScanning ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ScanLine className="size-4" />
                )}
                Scan selected
                {selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </Button>
              <Button variant="outline" onClick={scanAll} disabled={isScanning}>
                <ScanLine className="size-4" /> Scan all
              </Button>
            </>
          )}
          {canConfigureColumns && (
            <Button variant="outline" onClick={() => setColumnsOpen(true)}>
              <Columns3 className="size-4" /> Columns
            </Button>
          )}
          {canWrite && (
            <Button onClick={() => setFormOpen(true)}>
              <Plus className="size-4" /> New asset
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => toast.success("Export started", { description: "CSV of current view." })}
          >
            <Download className="size-4" /> Export
          </Button>
          <Button
            variant="outline"
            onClick={() => toast("Scan QR", { description: "Camera scan coming later." })}
          >
            <QrCode className="size-4" /> Scan QR
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer whitespace-nowrap"
                  onClick={() => openAsset(row.original.id)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      onClick={
                        cell.column.id === "actions" ||
                        cell.column.id === "select"
                          ? (e) => e.stopPropagation()
                          : undefined
                      }
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {assets.length === 0
                    ? emptyMessage ?? "No assets yet."
                    : "No assets match your filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-2 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {table.getFilteredRowModel().rows.length} asset
          {table.getFilteredRowModel().rows.length === 1 ? "" : "s"} ·{" "}
          {table.getState().pagination.pageIndex + 1} of{" "}
          {Math.max(table.getPageCount(), 1)}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );

  const dialog = canWrite ? (
    <AssetFormDialog
      open={formOpen}
      onOpenChange={setFormOpen}
      mode="create"
      people={people}
      locations={leafLocations}
      presetType={type}
    />
  ) : null;

  const picker = canConfigureColumns ? (
    <ColumnPickerDialog
      open={columnsOpen}
      onOpenChange={setColumnsOpen}
      view={view}
      current={resolvedIds}
    />
  ) : null;

  if (!title)
    return (
      <>
        {card}
        {dialog}
        {picker}
      </>
    );

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      {card}
      {dialog}
      {picker}
    </div>
  );
}
