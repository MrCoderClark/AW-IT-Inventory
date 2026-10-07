"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { installPrinterAction } from "@/app/(app)/printer-install-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EMPTY_INSTALL_FORM,
  installFieldErrors,
  installInputSchema,
  type InstallFormValues,
} from "@/lib/printer-install-schema";
import { cn } from "@/lib/utils";

/** Client-safe view of a driver package (no file paths / hashes). */
export interface PackageOption {
  id: string;
  name: string;
  vendor: string;
  model: string;
  driverName: string;
  arch: string;
  defaultConnectionType: "tcpip" | "wsd" | "share";
  defaultPort: number | null;
  defaultPrinterName: string | null;
}

export interface PrinterOption {
  assetId: string;
  tag: string;
  name: string;
  ip: string;
  model: string | null;
}

type FieldErrors = Partial<Record<keyof InstallFormValues, string>>;

export function PrinterInstallDialog({
  open,
  onOpenChange,
  assetTag,
  packages,
  printerOptions,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetTag: string;
  packages: PackageOption[];
  printerOptions: PrinterOption[];
  onSuccess?: () => void;
}) {
  const [values, setValues] = React.useState<InstallFormValues>(EMPTY_INSTALL_FORM);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [sourceAssetId, setSourceAssetId] = React.useState<string>("");
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setValues(EMPTY_INSTALL_FORM);
    setSourceAssetId("");
  }, [open]);

  function set<K extends keyof InstallFormValues>(key: K, value: InstallFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function choosePackage(id: string) {
    const pkg = packages.find((p) => p.id === id);
    setValues((v) => ({
      ...v,
      packageId: id,
      connectionType: pkg?.defaultConnectionType ?? "tcpip",
      port: pkg?.defaultPort ? String(pkg.defaultPort) : v.port,
      printerName: v.printerName || pkg?.defaultPrinterName || pkg?.name || "",
    }));
    setErrors((e) => ({ ...e, packageId: undefined }));
  }

  function prefillFromPrinter(assetId: string) {
    setSourceAssetId(assetId);
    const p = printerOptions.find((o) => o.assetId === assetId);
    if (!p) return;
    setValues((v) => ({
      ...v,
      connectionType: "tcpip",
      host: p.ip,
      printerName: v.printerName || p.name,
    }));
  }

  function submit() {
    const parsed = installInputSchema.safeParse({
      ...values,
      port: values.port === "" ? undefined : values.port,
    });
    if (!parsed.success) {
      setErrors(installFieldErrors(parsed.error));
      return;
    }
    startTransition(async () => {
      const res = await installPrinterAction(
        assetTag,
        { ...values, port: values.port === "" ? undefined : values.port },
        sourceAssetId || undefined,
      );
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.error);
      }
    });
  }

  const conn = values.connectionType;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>Install printer</DialogTitle>
          <DialogDescription>
            The collector installs this printer on the computer over WinRM. Pick a
            driver package and the connection.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-3 border-y p-4">
            <Field label="Driver package" required error={errors.packageId}>
              {packages.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No driver packages found. Add one under the drivers folder (see
                  spec 20).
                </p>
              ) : (
                <Select
                  value={values.packageId || null}
                  onValueChange={(v) => choosePackage(v ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a package">
                      {(value) =>
                        packages.find((p) => p.id === value)?.name ??
                        "Choose a package"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {packages.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.model ? ` — ${p.model}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {printerOptions.length > 0 && (
              <Field label="Prefill from an existing printer (optional)">
                <Select
                  value={sourceAssetId || null}
                  onValueChange={(v) => prefillFromPrinter(v ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None">
                      {(value) =>
                        printerOptions.find((o) => o.assetId === value)?.name ??
                        "None"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {printerOptions.map((o) => (
                      <SelectItem key={o.assetId} value={o.assetId}>
                        {o.name} ({o.ip})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            <Field label="Printer name" required error={errors.printerName}>
              <Input
                value={values.printerName}
                onChange={(e) => set("printerName", e.target.value)}
                placeholder="e.g. Finance Canon"
                aria-invalid={!!errors.printerName}
              />
            </Field>

            <Field label="Connection">
              <Select
                value={conn}
                onValueChange={(v) =>
                  set("connectionType", (v as InstallFormValues["connectionType"]) ?? "tcpip")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcpip">Network (TCP/IP)</SelectItem>
                  <SelectItem value="wsd">WSD</SelectItem>
                  <SelectItem value="share">Shared queue</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {conn === "tcpip" && (
              <div className="grid grid-cols-3 gap-3">
                <Field
                  label="Printer IP / host"
                  required
                  error={errors.host}
                  className="col-span-2"
                >
                  <Input
                    value={values.host}
                    onChange={(e) => set("host", e.target.value)}
                    placeholder="192.168.70.202"
                    aria-invalid={!!errors.host}
                  />
                </Field>
                <Field label="Port">
                  <Input
                    value={values.port}
                    onChange={(e) => set("port", e.target.value)}
                    placeholder="9100"
                    className="font-mono"
                  />
                </Field>
              </div>
            )}

            {conn === "tcpip" && (
              <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span className="text-sm">
                  Replace any existing printer/port on this IP
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Clears a decommissioned device that reused this address.
                  </span>
                </span>
                <Switch
                  checked={values.replaceExisting}
                  onCheckedChange={(v) => set("replaceExisting", v)}
                />
              </label>
            )}

            {conn === "wsd" && (
              <Field label="Host (optional)">
                <Input
                  value={values.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="printer hostname"
                />
              </Field>
            )}

            {conn === "share" && (
              <Field label="Share path" required error={errors.sharePath}>
                <Input
                  value={values.sharePath}
                  onChange={(e) => set("sharePath", e.target.value)}
                  placeholder="\\\\server\\queue"
                  className="font-mono"
                  aria-invalid={!!errors.sharePath}
                />
              </Field>
            )}
          </div>

          <DialogFooter className="rounded-none border-0 bg-transparent p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || packages.length === 0}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              Queue install
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </label>
  );
}
