"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  FileCode2,
  Loader2,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { deleteSoftwarePackageAction } from "@/app/(app)/software-deploy-actions";
import type { SoftwareStep } from "@/db/schema";
import { HeroHeader } from "@/components/hero-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type SoftwarePackageItem = {
  id: string;
  name: string;
  version: string;
  publisher: string | null;
  uploadedBy: string;
  createdAt: string;
  steps: SoftwareStep[];
};

function typeFromName(name: string): "msi" | "exe" | null {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "msi" ? "msi" : ext === "exe" ? "exe" : null;
}

/**
 * POST, retrying once on a 401. A long editing session can outlive the access
 * token; the proxy refreshes the cookie on the failing request, so the retry goes
 * through with the fresh cookie and the user never sees the lapse.
 */
async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 401) return res;
  return fetch(url, init);
}

/**
 * The Software Library (spec 23): build packages as an ordered list of steps
 * (inline PowerShell + MSI/EXE installers), then deploy them to computers from each
 * computer's detail page. Only rendered for a `software:deploy` admin.
 */
export function SoftwareLibrary({
  initialItems,
  storageConfigured,
}: {
  initialItems: SoftwarePackageItem[];
  storageConfigured: boolean;
}) {
  const router = useRouter();
  const [editorState, setEditorState] = React.useState<
    { mode: "create" } | { mode: "edit"; pkg: SoftwarePackageItem } | null
  >(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  async function remove(pkg: SoftwarePackageItem) {
    if (
      !window.confirm(
        `Delete "${pkg.name}" ${pkg.version}? This removes its installer files. Deployment history is kept.`,
      )
    )
      return;
    setDeletingId(pkg.id);
    try {
      const res = await deleteSoftwarePackageAction(pkg.id);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <HeroHeader
        icon={<Boxes />}
        title="Software Library"
        subtitle="Build a package as an ordered list of steps — PowerShell and MSI/EXE installers — then deploy it to any managed computer. Steps run in order and stop on the first failure."
        actions={
          <Button
            onClick={() => setEditorState({ mode: "create" })}
            disabled={!storageConfigured}
          >
            <PackagePlus className="size-4" /> New package
          </Button>
        }
      />

      {!storageConfigured && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Object storage isn&apos;t configured, so installer files can&apos;t be
          uploaded. Set <code>S3_ENDPOINT</code>, <code>S3_ACCESS_KEY_ID</code>,{" "}
          <code>S3_SECRET_ACCESS_KEY</code>, and <code>S3_BUCKET</code> in{" "}
          <code>web/.env</code>.
        </p>
      )}

      {initialItems.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-(--radius-card) border border-dashed py-16 text-center text-muted-foreground">
          <Package className="size-8 opacity-50" />
          <p className="text-sm">No packages yet.</p>
          <p className="text-xs">Create a package to start a library.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-(--radius-card) border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Uploaded by</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialItems.map((p) => (
                <React.Fragment key={p.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-medium">
                        {expanded === p.id ? (
                          <ChevronUp className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        )}
                        {p.name}
                      </div>
                      {p.publisher && (
                        <div className="pl-5 text-xs text-muted-foreground">
                          {p.publisher}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{p.version}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.uploadedBy}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditorState({ mode: "edit", pkg: p });
                          }}
                          aria-label={`Edit ${p.name}`}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(p);
                          }}
                          disabled={deletingId === p.id}
                          aria-label={`Delete ${p.name}`}
                        >
                          {deletingId === p.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expanded === p.id && (
                    <TableRow>
                      <TableCell colSpan={5} className="bg-muted/30">
                        <ol className="flex flex-col gap-1.5 py-1 pl-2">
                          {p.steps.map((s, i) => (
                            <li key={i} className="flex items-center gap-2 text-sm">
                              <span className="w-5 text-right tabular-nums text-muted-foreground">
                                {i + 1}.
                              </span>
                              {s.kind === "script" ? (
                                <Terminal className="size-3.5 text-muted-foreground" />
                              ) : (
                                <FileCode2 className="size-3.5 text-muted-foreground" />
                              )}
                              <span>{s.name}</span>
                              {s.kind === "install" && (
                                <Badge variant="secondary" className="text-[10px]">
                                  {s.installerType.toUpperCase()}
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ol>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editorState && (
        <PackageEditor
          initial={editorState.mode === "edit" ? editorState.pkg : undefined}
          onClose={() => setEditorState(null)}
          onSaved={() => {
            setEditorState(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

type CompanionFile = {
  uiId: string;
  fileName: string;
  storageKey: string;
  sha256: string;
  fileSize: number;
  uploading: boolean;
};

type EditorStep =
  | {
      uiId: string;
      kind: "script";
      name: string;
      script: string;
      continueOnError: boolean;
    }
  | {
      uiId: string;
      kind: "install";
      name: string;
      installerType: "msi" | "exe";
      fileName: string;
      silentArgs: string;
      sha256: string;
      storageKey: string;
      fileSize: number;
      uploading: boolean;
      companions: CompanionFile[];
      continueOnError: boolean;
    };

/** Hydrate a saved package's steps into editor steps (files already uploaded). */
function toEditorSteps(steps: SoftwareStep[]): EditorStep[] {
  return steps.map((s) =>
    s.kind === "script"
      ? {
          uiId: crypto.randomUUID(),
          kind: "script",
          name: s.name,
          script: s.script,
          continueOnError: s.continueOnError ?? false,
        }
      : {
          uiId: crypto.randomUUID(),
          kind: "install",
          name: s.name,
          installerType: s.installerType,
          fileName: s.fileName,
          silentArgs: s.silentArgs,
          sha256: s.sha256,
          storageKey: s.storageKey,
          fileSize: s.fileSize,
          uploading: false,
          continueOnError: s.continueOnError ?? false,
          companions: (s.companions ?? []).map((c) => ({
            uiId: crypto.randomUUID(),
            fileName: c.fileName,
            storageKey: c.storageKey,
            sha256: c.sha256,
            fileSize: c.fileSize,
            uploading: false,
          })),
        },
  );
}

function PackageEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: SoftwarePackageItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [version, setVersion] = React.useState(initial?.version ?? "");
  const [publisher, setPublisher] = React.useState(initial?.publisher ?? "");
  const [steps, setSteps] = React.useState<EditorStep[]>(() =>
    initial ? toEditorSteps(initial.steps) : [],
  );
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const companionInputs = React.useRef<Record<string, HTMLInputElement | null>>({});

  function move(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function removeStep(uiId: string) {
    setSteps((prev) => prev.filter((s) => s.uiId !== uiId));
  }
  function patch(uiId: string, fields: Partial<EditorStep>) {
    setSteps((prev) =>
      prev.map((s) => (s.uiId === uiId ? ({ ...s, ...fields } as EditorStep) : s)),
    );
  }

  function addScript() {
    setSteps((prev) => [
      ...prev,
      {
        uiId: crypto.randomUUID(),
        kind: "script",
        name: "",
        script: "",
        continueOnError: false,
      },
    ]);
  }

  async function addInstaller(file: File) {
    const type = typeFromName(file.name);
    if (!type) return toast.error("Only .msi or .exe files.");
    const uiId = crypto.randomUUID();
    setSteps((prev) => [
      ...prev,
      {
        uiId,
        kind: "install",
        name: file.name,
        installerType: type,
        fileName: file.name,
        silentArgs: "",
        sha256: "",
        storageKey: "",
        fileSize: file.size,
        uploading: true,
        companions: [],
        continueOnError: false,
      },
    ]);
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await postWithRetry("/api/software/packages/files", {
        method: "POST",
        body,
      });
      if (res.ok) {
        const data = await res.json();
        patch(uiId, { ...data.file, uploading: false });
      } else {
        const d = await res.json().catch(() => null);
        toast.error(d?.error ?? "Could not upload the installer.");
        removeStep(uiId);
      }
    } catch {
      toast.error("Could not upload the installer.");
      removeStep(uiId);
    }
  }

  // Map over an install step's companions (type-narrowing helper).
  function updateCompanions(
    stepUiId: string,
    fn: (c: CompanionFile[]) => CompanionFile[],
  ) {
    setSteps((prev) =>
      prev.map((s) =>
        s.uiId === stepUiId && s.kind === "install"
          ? { ...s, companions: fn(s.companions) }
          : s,
      ),
    );
  }

  function removeCompanion(stepUiId: string, cid: string) {
    updateCompanions(stepUiId, (cs) => cs.filter((c) => c.uiId !== cid));
  }

  async function addCompanion(stepUiId: string, file: File) {
    const cid = crypto.randomUUID();
    updateCompanions(stepUiId, (cs) => [
      ...cs,
      {
        uiId: cid,
        fileName: file.name,
        storageKey: "",
        sha256: "",
        fileSize: file.size,
        uploading: true,
      },
    ]);
    const body = new FormData();
    body.append("file", file);
    body.append("role", "companion");
    try {
      const res = await postWithRetry("/api/software/packages/files", {
        method: "POST",
        body,
      });
      if (res.ok) {
        const data = await res.json();
        updateCompanions(stepUiId, (cs) =>
          cs.map((c) =>
            c.uiId === cid
              ? {
                  ...c,
                  storageKey: data.file.storageKey,
                  sha256: data.file.sha256,
                  fileSize: data.file.fileSize,
                  uploading: false,
                }
              : c,
          ),
        );
      } else {
        const d = await res.json().catch(() => null);
        toast.error(d?.error ?? "Could not upload the file.");
        updateCompanions(stepUiId, (cs) => cs.filter((c) => c.uiId !== cid));
      }
    } catch {
      toast.error("Could not upload the file.");
      updateCompanions(stepUiId, (cs) => cs.filter((c) => c.uiId !== cid));
    }
  }

  async function save() {
    if (!name.trim()) return toast.error("Enter a package name.");
    if (!version.trim()) return toast.error("Enter a version.");
    if (steps.length === 0) return toast.error("Add at least one step.");
    for (const s of steps) {
      if (s.kind === "install") {
        if (s.uploading) return toast.error("Wait for the upload to finish.");
        if (!s.storageKey) return toast.error("An installer failed to upload.");
        if (s.companions.some((c) => c.uploading))
          return toast.error("Wait for a companion file to finish uploading.");
        if (s.installerType === "exe" && !s.silentArgs.trim())
          return toast.error(`"${s.name}" (EXE) needs silent arguments.`);
      } else if (!s.script.trim()) {
        return toast.error("A script step is empty.");
      }
    }

    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        version: version.trim(),
        publisher: publisher.trim(),
        steps: steps.map((s) =>
          s.kind === "script"
            ? {
                kind: "script",
                name: s.name.trim(),
                script: s.script,
                continueOnError: s.continueOnError,
              }
            : {
                kind: "install",
                name: s.name.trim(),
                installerType: s.installerType,
                fileName: s.fileName,
                silentArgs: s.silentArgs.trim(),
                sha256: s.sha256,
                storageKey: s.storageKey,
                fileSize: s.fileSize,
                continueOnError: s.continueOnError,
                companions: s.companions.map((c) => ({
                  storageKey: c.storageKey,
                  sha256: c.sha256,
                  fileName: c.fileName,
                  fileSize: c.fileSize,
                })),
              },
        ),
      };
      const res = await postWithRetry(
        initial ? `/api/software/packages/${initial.id}` : "/api/software/packages",
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        toast.success(initial ? "Package updated." : "Package created.");
        onSaved();
      } else {
        const d = await res.json().catch(() => null);
        toast.error(
          d?.error ??
            (initial ? "Could not update the package." : "Could not create the package."),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit package" : "New software package"}</DialogTitle>
          <DialogDescription>
            Steps run in order on the target and stop on the first failure. A plain
            installer is just one install step.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ePad II signature pad" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Version</label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="12.4" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">
              Publisher <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input value={publisher} onChange={(e) => setPublisher(e.target.value)} placeholder="ePadLink" />
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-sm font-medium">Steps</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={addScript}>
                <Terminal className="size-3.5" /> Script
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                <Plus className="size-3.5" /> Installer
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".msi,.exe"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void addInstaller(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {steps.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              Add a script step (e.g. enable a Windows feature) or an installer step.
            </p>
          )}

          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={s.uiId} className="rounded-lg border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  {s.kind === "script" ? (
                    <Terminal className="size-4 text-muted-foreground" />
                  ) : (
                    <FileCode2 className="size-4 text-muted-foreground" />
                  )}
                  <Input
                    value={s.name}
                    onChange={(e) => patch(s.uiId, { name: e.target.value })}
                    placeholder={s.kind === "script" ? "Step name (e.g. Enable .NET 3.5)" : s.name}
                    className="h-8"
                  />
                  {s.kind === "install" && (
                    <Badge variant="secondary">{s.installerType.toUpperCase()}</Badge>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                      <ChevronDown className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => removeStep(s.uiId)} aria-label="Remove step">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {s.kind === "script" ? (
                  <Textarea
                    value={s.script}
                    onChange={(e) => patch(s.uiId, { script: e.target.value })}
                    placeholder={"# PowerShell, runs elevated\nEnable-WindowsOptionalFeature -Online -FeatureName NetFx3 -All -NoRestart"}
                    className="mt-2 min-h-24 font-mono text-xs"
                  />
                ) : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <div className="text-xs text-muted-foreground">
                      {s.fileName}
                      {s.uploading && (
                        <span className="ml-2 inline-flex items-center gap-1">
                          <Loader2 className="size-3 animate-spin" /> uploading…
                        </span>
                      )}
                    </div>
                    <Input
                      value={s.silentArgs}
                      onChange={(e) => patch(s.uiId, { silentArgs: e.target.value })}
                      placeholder={
                        s.installerType === "exe"
                          ? 'Silent args (required) — e.g. /S  or  /s /v"/qn"'
                          : "Extra msiexec args (optional) — MSI uses /qn"
                      }
                      className="h-8 font-mono text-xs"
                    />
                    {/* Companion files (response .iss / .mst / config), staged
                        beside the installer. Reference one with %DIR% in the args. */}
                    {s.companions.map((c) => (
                      <div
                        key={c.uiId}
                        className="flex items-center gap-2 pl-3 text-xs text-muted-foreground"
                      >
                        <FileCode2 className="size-3" />
                        <span className="truncate">{c.fileName}</span>
                        {c.uploading ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => removeCompanion(s.uiId, c.uiId)}
                            aria-label={`Remove ${c.fileName}`}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <div>
                      <input
                        ref={(el) => {
                          companionInputs.current[s.uiId] = el;
                        }}
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void addCompanion(s.uiId, f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => companionInputs.current[s.uiId]?.click()}
                      >
                        <Plus className="size-3" /> Companion file
                      </Button>
                    </div>
                  </div>
                )}
                <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={s.continueOnError}
                    onChange={(e) =>
                      patch(s.uiId, { continueOnError: e.target.checked })
                    }
                  />
                  Continue to the next step even if this one fails
                </label>
              </li>
            ))}
          </ol>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}
            {initial ? "Save changes" : "Create package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
