"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Layers, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  createDeviceGroupAction,
  deleteDeviceGroupAction,
  previewDeviceGroupAction,
  updateDeviceGroupAction,
} from "@/app/(app)/device-group-actions";
import { HeroHeader } from "@/components/hero-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DeviceGroupListItem } from "@/db/device-groups";
import type { DeviceGroupRules } from "@/db/schema";
import type { LocationOption } from "@/lib/data";
import {
  hasMeaningfulDeviceGroupRules,
  normalizeDeviceGroupRules,
  type DeviceGroupCompliance,
} from "@/lib/device-group-rules";

function rulesSummary(rules: DeviceGroupRules, locations: LocationOption[]): string {
  const n = normalizeDeviceGroupRules(rules);
  const parts: string[] = [];
  if (n.locationId) {
    const loc = locations.find((l) => l.id === n.locationId);
    parts.push(loc?.path ?? "Location");
  }
  if (n.osContains) parts.push(`OS contains “${n.osContains}”`);
  if (n.compliance === "at-risk") parts.push("At risk");
  if (n.compliance === "ok") parts.push("Compliant");
  return parts.join(" · ") || "—";
}

export function DeviceGroupsView({
  groups,
  locations,
}: {
  groups: DeviceGroupListItem[];
  locations: LocationOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DeviceGroupListItem | null>(null);
  const [busy, startBusy] = React.useTransition();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [locationId, setLocationId] = React.useState("");
  const [osContains, setOsContains] = React.useState("");
  const [compliance, setCompliance] =
    React.useState<DeviceGroupCompliance>("any");
  const [preview, setPreview] = React.useState<{
    matched: number;
    withIp: number;
    sampleTags: string[];
  } | null>(null);

  function currentRules(): DeviceGroupRules {
    return normalizeDeviceGroupRules({
      locationId: locationId || null,
      osContains: osContains || null,
      compliance,
    });
  }

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setLocationId("");
    setOsContains("");
    setCompliance("any");
    setPreview(null);
    setOpen(true);
  }

  function openEdit(g: DeviceGroupListItem) {
    const r = normalizeDeviceGroupRules(g.rules);
    setEditing(g);
    setName(g.name);
    setDescription(g.description ?? "");
    setLocationId(r.locationId ?? "");
    setOsContains(r.osContains ?? "");
    setCompliance(r.compliance ?? "any");
    setPreview(null);
    setOpen(true);
  }

  function refreshPreview() {
    startBusy(async () => {
      const res = await previewDeviceGroupAction({ rules: currentRules() });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPreview({
        matched: res.matched,
        withIp: res.withIp,
        sampleTags: res.sampleTags,
      });
    });
  }

  function save() {
    const rules = currentRules();
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (!hasMeaningfulDeviceGroupRules(rules)) {
      toast.error("Add at least one filter (location, OS, or compliance).");
      return;
    }
    startBusy(async () => {
      const res = editing
        ? await updateDeviceGroupAction({
            id: editing.id,
            name,
            description,
            rules,
          })
        : await createDeviceGroupAction({ name, description, rules });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      router.refresh();
    });
  }

  function remove(g: DeviceGroupListItem) {
    startBusy(async () => {
      const res = await deleteDeviceGroupAction(g.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      router.refresh();
    });
  }

  return (
    <>
      <HeroHeader
        title="Device groups"
        subtitle="Dynamic filters for script Run on… and schedules. Membership recomputes from location, OS, and compliance."
        icon={<Layers className="size-6" />}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            New group
          </Button>
        }
      />

      {groups.length === 0 ? (
        <div className="grid place-content-center gap-2 rounded-xl border border-dashed bg-card/50 py-16 text-center">
          <p className="text-sm font-semibold">No device groups yet</p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Create a group like “Win11 at-risk HQ”, then pick it when running or
            scheduling a script.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Rules</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {groups.map((g) => (
                <tr key={g.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{g.name}</div>
                    {g.description ? (
                      <div className="text-xs text-muted-foreground">
                        {g.description}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {rulesSummary(g.rules, locations)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(g)}
                        aria-label={`Edit ${g.name}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        onClick={() => remove(g)}
                        aria-label={`Delete ${g.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit device group" : "New device group"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Description</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Location subtree (optional)
              </span>
              <select
                className="rounded-md border bg-background px-2 py-1.5"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">Any location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {"\u00A0".repeat(l.depth * 2)}
                    {l.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                OS contains (optional)
              </span>
              <Input
                value={osContains}
                onChange={(e) => setOsContains(e.target.value)}
                placeholder="e.g. Windows 11"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Compliance</span>
              <select
                className="rounded-md border bg-background px-2 py-1.5"
                value={compliance}
                onChange={(e) =>
                  setCompliance(e.target.value as DeviceGroupCompliance)
                }
              >
                <option value="any">Any</option>
                <option value="at-risk">At risk</option>
                <option value="ok">Compliant (not at risk)</option>
              </select>
            </label>

            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Member preview</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={refreshPreview}
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Refresh
                </Button>
              </div>
              {preview ? (
                <p className="mt-1.5">
                  {preview.withIp} with IP
                  {preview.matched !== preview.withIp
                    ? ` · ${preview.matched - preview.withIp} no IP`
                    : ""}
                  {preview.sampleTags.length > 0
                    ? ` · e.g. ${preview.sampleTags.join(", ")}`
                    : ""}
                </p>
              ) : (
                <p className="mt-1.5 text-muted-foreground">
                  Refresh to count matching computers.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={save}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? "Save group" : "Create group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
