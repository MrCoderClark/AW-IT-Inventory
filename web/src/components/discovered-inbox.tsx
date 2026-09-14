"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Ban,
  Check,
  Inbox,
  Link2,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import {
  createAssetFromDevice,
  ignoreDevice,
  linkDevice,
  restoreDevice,
} from "@/app/(app)/scans/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  kindMeta,
  TYPE_ICON,
  type ActionResult,
  type DiscoveredDevice,
  type LinkAsset,
} from "@/lib/data";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 8;

function fmtDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

const STRENGTH_STYLE: Record<string, string> = {
  exact: "border-transparent bg-primary text-primary-foreground",
  strong: "border-primary/30 bg-accent text-primary",
  weak: "border-border bg-muted text-muted-foreground",
};

export function DiscoveredInbox({
  devices,
  assets,
  view,
  canWrite,
}: {
  devices: DiscoveredDevice[];
  assets: LinkAsset[];
  view: "inbox" | "ignored";
  canWrite: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [linkFor, setLinkFor] = React.useState<DiscoveredDevice | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) =>
      [d.hostname, d.ip, d.serial, d.subnet, d.os]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [devices, query]);

  // Keep the page in range as the list shrinks (after an action) or filters.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );

  function run(id: string, action: () => Promise<ActionResult>) {
    setPendingId(id);
    startTransition(async () => {
      const res = await action();
      setPendingId(null);
      setLinkFor(null);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  function switchView(next: "inbox" | "ignored") {
    setPage(0);
    setQuery("");
    router.push(next === "ignored" ? `${pathname}?view=ignored` : pathname, {
      scroll: false,
    });
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Discovered devices
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Machines seen by the collector that aren&apos;t managed assets yet.
            Link, create, or ignore each one.
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-card p-1">
          <ViewTab
            active={view === "inbox"}
            onClick={() => switchView("inbox")}
            icon={Inbox}
            label="Inbox"
          />
          <ViewTab
            active={view === "ignored"}
            onClick={() => switchView("ignored")}
            icon={Ban}
            label="Ignored"
          />
        </div>
      </header>

      <div className="relative w-full sm:max-w-xs">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search host, IP, serial…"
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState view={view} filtered={Boolean(query)} />
      ) : (
        <div className="flex flex-col gap-3">
          {pageRows.map((d) => (
            <DeviceCard
              key={d.id}
              device={d}
              view={view}
              canWrite={canWrite}
              busy={isPending && pendingId === d.id}
              disabled={isPending}
              onLink={(assetId) =>
                run(d.id, () => linkDevice(d.id, assetId))
              }
              onOpenPicker={() => setLinkFor(d)}
              onCreate={() => run(d.id, () => createAssetFromDevice(d.id))}
              onIgnore={() => run(d.id, () => ignoreDevice(d.id))}
              onRestore={() => run(d.id, () => restoreDevice(d.id))}
            />
          ))}
        </div>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {filtered.length} device{filtered.length === 1 ? "" : "s"} ·{" "}
            {safePage + 1} of {pageCount}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <LinkDialog
        device={linkFor}
        assets={assets}
        busy={isPending}
        onClose={() => setLinkFor(null)}
        onPick={(assetId) =>
          linkFor && run(linkFor.id, () => linkDevice(linkFor.id, assetId))
        }
      />
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-accent text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

function DeviceCard({
  device,
  view,
  canWrite,
  busy,
  disabled,
  onLink,
  onOpenPicker,
  onCreate,
  onIgnore,
  onRestore,
}: {
  device: DiscoveredDevice;
  view: "inbox" | "ignored";
  canWrite: boolean;
  busy: boolean;
  disabled: boolean;
  onLink: (assetId: string) => void;
  onOpenPicker: () => void;
  onCreate: () => void;
  onIgnore: () => void;
  onRestore: () => void;
}) {
  const meta = kindMeta(device.kind);
  const Icon = meta.icon;
  const facts = [
    device.ip,
    device.subnet,
    device.os,
    device.serial && `SN ${device.serial}`,
    device.spec,
  ].filter(Boolean);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold">
              {device.hostname || device.ip || "Unknown host"}
              <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {meta.label}
              </span>
            </p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {facts.join("  ·  ") || "No scan details"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last seen {fmtDate(device.lastSeen)}
            </p>
          </div>
        </div>

        {/* Actions */}
        {canWrite && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {view === "inbox" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenPicker}
                  disabled={disabled}
                >
                  <Link2 className="size-4" /> Link…
                </Button>
                <Button size="sm" onClick={onCreate} disabled={disabled}>
                  <Plus className="size-4" /> Create asset
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={onIgnore}
                  disabled={disabled}
                >
                  <Ban className="size-4" /> Ignore
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onRestore}
                disabled={disabled}
              >
                <RotateCcw className="size-4" /> Restore
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Suggestions (active inbox only) */}
      {view === "inbox" && device.suggestions.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Suggested matches
          </p>
          <div className="flex flex-wrap gap-2">
            {device.suggestions.map((s) => {
              const SIcon = TYPE_ICON[s.type];
              return (
                <div
                  key={s.assetId}
                  className="flex items-center gap-2 rounded-lg border bg-background py-1.5 pl-2 pr-1.5"
                >
                  <SIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {s.tag}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      STRENGTH_STYLE[s.strength],
                    )}
                  >
                    {s.reason}
                  </span>
                  {canWrite && (
                    <Button
                      size="sm"
                      className="h-7"
                      onClick={() => onLink(s.assetId)}
                      disabled={disabled}
                    >
                      <Check className="size-3.5" /> Link
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {busy && (
        <p className="mt-3 text-xs text-muted-foreground">Working…</p>
      )}
    </div>
  );
}

function LinkDialog({
  device,
  assets,
  busy,
  onClose,
  onPick,
}: {
  device: DiscoveredDevice | null;
  assets: LinkAsset[];
  busy: boolean;
  onClose: () => void;
  onPick: (assetId: string) => void;
}) {
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    if (device) setQ("");
  }, [device]);

  const results = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = needle
      ? assets.filter((a) =>
          [a.name, a.tag, a.serial, a.type]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : assets;
    return pool.slice(0, 50);
  }, [assets, q]);

  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link to an existing asset</DialogTitle>
          <DialogDescription>
            {device?.hostname || device?.ip || "This device"} → pick the asset
            it belongs to.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search assets by name, tag, or serial…"
            className="pl-9"
          />
        </div>

        <div className="max-h-72 overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No assets match “{q}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results.map((a) => {
                const SIcon = TYPE_ICON[a.type];
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => onPick(a.id)}
                      disabled={busy}
                      className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border hover:bg-accent/50 disabled:opacity-50"
                    >
                      <SIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.name}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {a.tag}
                          {a.serial ? ` · ${a.serial}` : ""}
                        </p>
                      </div>
                      <Link2 className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({
  view,
  filtered,
}: {
  view: "inbox" | "ignored";
  filtered: boolean;
}) {
  const { title, body, Icon } = filtered
    ? {
        title: "No matches",
        body: "No devices match your search.",
        Icon: Search,
      }
    : view === "ignored"
      ? {
          title: "Nothing ignored",
          body: "Devices you dismiss from the inbox will collect here.",
          Icon: Ban,
        }
      : {
          title: "Inbox zero",
          body: "Every scanned device is either a managed asset or ignored. Run the collector to discover more.",
          Icon: ScanLine,
        };

  return (
    <div className="grid place-content-center gap-3 rounded-xl border border-dashed bg-card/50 py-20 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent text-primary">
        <Icon className="size-7" />
      </span>
      <p className="text-lg font-semibold">{title}</p>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
