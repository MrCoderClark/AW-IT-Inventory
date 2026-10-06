"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, KeyRound, Pencil, Plus, Search, Users } from "lucide-react";

import { PersonFormDialog } from "@/components/person-form-dialog";
import { Badge } from "@/components/ui/badge";
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
import type { DirectoryPerson, LocationOption } from "@/lib/data";
import type { PersonFormValues } from "@/lib/person-schema";

const PAGE_SIZE = 10;

type StatusFilter = "active" | "archived" | "all";

/** Map a directory row to the edit form's values. */
function toFormValues(p: DirectoryPerson): PersonFormValues {
  return {
    name: p.name,
    email: p.email,
    department: p.department,
    jobTitle: p.jobTitle,
    phone: p.phone,
    employeeId: p.employeeId,
    officeLocationId: p.officeLocationId ?? "",
  };
}

export function PeopleDirectory({
  people,
  canWrite = false,
  locations = [],
  loginEmails,
}: {
  people: DirectoryPerson[];
  canWrite?: boolean;
  locations?: LocationOption[];
  /** Lowercased emails that have an OPUS login (admins only), for the badge. */
  loginEmails?: string[];
}) {
  const loginSet = React.useMemo(
    () => new Set(loginEmails ?? []),
    [loginEmails],
  );
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("active");
  const [page, setPage] = React.useState(0);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DirectoryPerson | null>(null);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return people.filter((p) => {
      if (status !== "all" && p.status !== status) return false;
      if (!term) return true;
      return (
        p.name.toLowerCase().includes(term) ||
        p.email.toLowerCase().includes(term) ||
        p.department.toLowerCase().includes(term) ||
        p.jobTitle.toLowerCase().includes(term)
      );
    });
  }, [people, search, status]);

  const pageCount = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
  const clampedPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE,
  );

  return (
    <div className="rounded-xl border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0); // a new search starts from the first page
            }}
            placeholder="Search people…"
            className="pl-9"
          />
        </div>

        <Select
          value={status}
          onValueChange={(v) => {
            setStatus((v as StatusFilter) ?? "active");
            setPage(0); // switching the status filter resets to the first page
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>

        {canWrite && (
          <div className="ml-auto">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New person
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Job title</TableHead>
              <TableHead className="w-[100px] text-right">Devices</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="w-[80px]" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((p) => (
                <TableRow key={p.id} className="group">
                  <TableCell>
                    <Link
                      href={`/people/${p.id}`}
                      className="flex items-center gap-2.5 font-medium hover:underline"
                    >
                      <span
                        aria-hidden
                        className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-semibold text-primary"
                      >
                        {p.initials}
                      </span>
                      {p.name}
                      {p.email && loginSet.has(p.email.toLowerCase()) && (
                        <Badge
                          variant="secondary"
                          className="gap-1"
                          title="Has an OPUS login"
                        >
                          <KeyRound className="size-3" />
                          Login
                        </Badge>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.email || "—"}
                  </TableCell>
                  <TableCell>{p.department || "—"}</TableCell>
                  <TableCell>{p.jobTitle || "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.deviceCount === 0 ? (
                      <span className="text-muted-foreground">0</span>
                    ) : (
                      p.deviceCount
                    )}
                  </TableCell>
                  <TableCell>
                    {p.status === "archived" ? (
                      <Badge variant="secondary">Archived</Badge>
                    ) : (
                      <Badge variant="outline">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canWrite && (
                        <button
                          onClick={() => setEditing(p)}
                          aria-label={`Edit ${p.name}`}
                          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      <Link
                        href={`/people/${p.id}`}
                        aria-label={`View ${p.name}`}
                        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center">
                  <span className="inline-flex flex-col items-center gap-2 text-muted-foreground">
                    <Users className="size-6" />
                    <span className="text-sm">
                      {people.length === 0
                        ? "No people yet."
                        : "No people match your search."}
                    </span>
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-2 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "person" : "people"} ·{" "}
          {clampedPage + 1} of {pageCount}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(p - 1, 0))}
            disabled={clampedPage === 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(p + 1, pageCount - 1))}
            disabled={clampedPage >= pageCount - 1}
          >
            Next
          </Button>
        </div>
      </div>

      {canWrite && (
        <>
          <PersonFormDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            mode="create"
            locations={locations}
          />
          <PersonFormDialog
            open={editing !== null}
            onOpenChange={(o) => !o && setEditing(null)}
            mode="edit"
            locations={locations}
            editId={editing?.id}
            initial={editing ? toFormValues(editing) : undefined}
          />
        </>
      )}
    </div>
  );
}
