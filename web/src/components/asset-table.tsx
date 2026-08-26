"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
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
  Download,
  MoreHorizontal,
  Plus,
  QrCode,
  Search,
} from "lucide-react";
import { toast } from "sonner";

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
import {
  STATUS_META,
  TYPE_ICON,
  type Asset,
  type AssetStatus,
} from "@/lib/data";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    openAsset: (id: string) => void;
  }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
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

const columns: ColumnDef<Asset>[] = [
  {
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
  },
  {
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
  },
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.type}</span>
    ),
    filterFn: "equals",
  },
  {
    accessorKey: "serial",
    header: "Serial Number",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.serial}
      </span>
    ),
  },
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.model}</span>
    ),
  },
  {
    id: "assignee",
    accessorFn: (a) => a.assignee?.name ?? "Pool",
    header: "Assigned To",
    cell: ({ row }) => {
      const a = row.original.assignee;
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
  },
  {
    accessorKey: "location",
    header: "Location",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.location}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: "equals",
  },
  {
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
  },
  {
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
  },
];

export function AssetTable({ assets }: { assets: Asset[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const openAsset = (id: string) =>
    router.push(`${pathname}?asset=${encodeURIComponent(id)}`, { scroll: false });

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [globalFilter, setGlobalFilter] = React.useState("");

  const table = useReactTable({
    data: assets,
    columns,
    state: { sorting, columnFilters, globalFilter },
    meta: { openAsset },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  });

  const typeFilter =
    (table.getColumn("type")?.getFilterValue() as string) ?? "all";
  const statusFilter =
    (table.getColumn("status")?.getFilterValue() as string) ?? "all";

  return (
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

        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => toast("Add Asset", { description: "Form coming in a later phase." })}>
            <Plus className="size-4" /> Add Asset
          </Button>
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
                        cell.column.id === "actions"
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
                  No assets match your filters.
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
          {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
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
}
