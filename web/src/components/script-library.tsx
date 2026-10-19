"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  archiveScriptAction,
  saveScriptAction,
} from "@/app/(app)/script-actions";
import { fmtDateTime } from "@/components/detail-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ScriptListItem } from "@/db/scripts";

export function ScriptLibrary({ initial }: { initial: ScriptListItem[] }) {
  const router = useRouter();
  const [rows, setRows] = React.useState(initial);
  React.useEffect(() => setRows(initial), [initial]);

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScriptListItem | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(120);
  const [busy, startBusy] = React.useTransition();

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setBody("");
    setTimeoutSeconds(120);
    setOpen(true);
  }

  function openEdit(row: ScriptListItem) {
    setEditing(row);
    setName(row.name);
    setDescription(row.description ?? "");
    setBody(row.body);
    setTimeoutSeconds(row.timeoutSeconds);
    setOpen(true);
  }

  function save() {
    startBusy(async () => {
      const res = await saveScriptAction({
        id: editing?.id,
        name,
        description,
        body,
        timeoutSeconds,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(editing ? "Script updated" : "Script created");
      setOpen(false);
      router.refresh();
    });
  }

  function archive(id: string) {
    startBusy(async () => {
      const res = await archiveScriptAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Script archived");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="size-4" /> New script
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Timeout</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No scripts yet. Create one to run on computers.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => openEdit(r)}
                    >
                      {r.name}
                    </button>
                    {r.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {r.description}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {r.timeoutSeconds}s
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtDateTime(r.updatedAt)} · {r.updatedBy}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => archive(r.id)}
                      aria-label={`Archive ${r.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit script" : "New script"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className="text-xs text-muted-foreground">
              Timeout (seconds, 30–600)
              <Input
                type="number"
                min={30}
                max={600}
                className="mt-1"
                value={timeoutSeconds}
                onChange={(e) =>
                  setTimeoutSeconds(Number(e.target.value) || 120)
                }
              />
            </label>
            <Textarea
              className="min-h-48 font-mono text-xs"
              placeholder="PowerShell body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !name.trim() || !body.trim()}
              onClick={save}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
