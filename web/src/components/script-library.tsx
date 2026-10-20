"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  addStarterScriptsAction,
  archiveScriptAction,
  saveScriptAction,
} from "@/app/(app)/script-actions";
import { AI_DRAFT_STORAGE_KEY } from "@/components/ai-assist-panel";
import { fmtDateTime } from "@/components/detail-ui";
import { ScriptRunOnDialog } from "@/components/script-run-on-dialog";
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
import type { LocationOption } from "@/lib/data";

/** Keep in sync with `SCRIPT_BODY_MAX` in `db/scripts.ts`. */
const SCRIPT_BODY_MAX = 64 * 1024;

export function ScriptLibrary({
  initial,
  computers,
  locations,
}: {
  initial: ScriptListItem[];
  computers: Array<{ tag: string; name: string }>;
  locations: LocationOption[];
}) {
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
  const [runOn, setRunOn] = React.useState<ScriptListItem | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const consumedAiDraft = React.useRef(false);

  // Spec 34 — open New script dialog prefilled from Assist draft handoff.
  React.useEffect(() => {
    if (consumedAiDraft.current) return;
    consumedAiDraft.current = true;
    try {
      const raw = sessionStorage.getItem(AI_DRAFT_STORAGE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(AI_DRAFT_STORAGE_KEY);
      const draft = JSON.parse(raw) as {
        name?: string;
        body?: string;
        notes?: string;
      };
      if (!draft.body?.trim()) return;
      setEditing(null);
      setName(draft.name?.trim() || "AI draft");
      setDescription(draft.notes?.trim() || "");
      setBody(draft.body.slice(0, SCRIPT_BODY_MAX));
      setTimeoutSeconds(120);
      setOpen(true);
      toast.message("AI draft loaded — review, then Save before running.");
      if (typeof window !== "undefined" && window.location.search.includes("aiDraft")) {
        router.replace("/scripts", { scroll: false });
      }
    } catch {
      /* ignore corrupt draft */
    }
  }, [router]);

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

  function onPickPs1(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.ps1$/i.test(file.name)) {
      toast.error("Choose a .ps1 file.");
      return;
    }
    if (file.size > SCRIPT_BODY_MAX) {
      toast.error("Script is too large (max 64 KB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result ?? "");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (text.length > SCRIPT_BODY_MAX) {
        toast.error("Script is too large (max 64 KB).");
        return;
      }
      setBody(text);
      if (!name.trim()) {
        setName(file.name.replace(/\.ps1$/i, "").replace(/[-_]+/g, " "));
      }
      toast.success(`Loaded ${file.name}`);
    };
    reader.onerror = () => toast.error("Could not read that file.");
    reader.readAsText(file);
  }

  function addStarters() {
    startBusy(async () => {
      const res = await addStarterScriptsAction();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.added.length === 0) {
        toast.message("Starter scripts already present");
      } else {
        toast.success(
          `Added ${res.added.length}: ${res.added.join(", ")}`,
        );
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={addStarters}>
          Add starter scripts
        </Button>
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
                      onClick={() => setRunOn(r)}
                      aria-label={`Run ${r.name} on…`}
                    >
                      <Play className="size-4" />
                    </Button>
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
        {/* sm:max-w-* must override DialogContent's default sm:max-w-sm */}
        <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <DialogTitle>{editing ? "Edit script" : "New script"}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[12rem] flex-1 text-xs text-muted-foreground">
                Name
                <Input
                  className="mt-1"
                  placeholder="Reset Print Spooler"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="w-28 text-xs text-muted-foreground">
                Timeout (s)
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-4" />
                Upload .ps1
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".ps1,text/plain"
                className="hidden"
                onChange={onPickPs1}
              />
            </div>
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className="flex min-h-0 flex-1 flex-col text-xs text-muted-foreground">
              PowerShell body
              <Textarea
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="mt-1 min-h-[min(50vh,28rem)] flex-1 resize-y field-sizing-fixed whitespace-pre font-mono text-xs leading-5"
                placeholder="Paste PowerShell, or upload a .ps1"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <span className="mt-1.5 leading-snug">
                Avoid <code className="text-[11px]">exit</code> — it can break
                result capture. Prefer{" "}
                <code className="text-[11px]">Write-Output</code> for messages
                and <code className="text-[11px]">throw</code> on failure. Put
                summaries at the end of long scripts.
              </span>
            </label>
          </div>
          <DialogFooter className="shrink-0">
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

      <ScriptRunOnDialog
        script={runOn}
        computers={computers}
        locations={locations}
        open={runOn !== null}
        onOpenChange={(o) => {
          if (!o) setRunOn(null);
        }}
      />
    </div>
  );
}
