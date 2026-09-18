"use client";

import * as React from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import { createAsset, updateAsset } from "@/app/(app)/assets/actions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ASSET_STATUSES,
  ASSET_TYPES,
  EMPTY_ASSET_FORM,
  assetInputSchema,
  fieldErrors,
  type AssetFormValues,
} from "@/lib/asset-schema";
import { STATUS_META, type AssetType } from "@/lib/data";
import { cn } from "@/lib/utils";

export interface PersonOption {
  id: string;
  name: string;
}

type FieldErrors = Partial<Record<keyof AssetFormValues, string>>;

export function AssetFormDialog({
  open,
  onOpenChange,
  mode,
  people,
  presetType,
  editTag,
  initial,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  people: PersonOption[];
  /** Create mode: pre-select the type (a category page). */
  presetType?: AssetType;
  /** Edit mode: the immutable tag being edited. */
  editTag?: string;
  /** Edit mode: the asset's current values, pre-filled into the form. */
  initial?: AssetFormValues;
  onSuccess?: () => void;
}) {
  const [values, setValues] = React.useState<AssetFormValues>(EMPTY_ASSET_FORM);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [isPending, startTransition] = React.useTransition();

  // Reset the form each time the dialog opens, to the edit values or a fresh
  // create form (with the category's type pre-selected).
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    if (mode === "edit" && initial) {
      setValues(initial);
    } else {
      setValues({
        ...EMPTY_ASSET_FORM,
        type: presetType ?? "",
      });
    }
    // initial/presetType are captured on open; re-running on their identity
    // would clobber in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  function set<K extends keyof AssetFormValues>(
    key: K,
    value: AssetFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit() {
    const parsed = assetInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    startTransition(async () => {
      const res =
        mode === "edit" && editTag
          ? await updateAsset(editTag, values)
          : await createAsset(values);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.error);
      }
    });
  }

  const title = mode === "edit" ? "Edit asset" : "New asset";
  const description =
    mode === "edit"
      ? "Update this asset's details. Type and tag are fixed."
      : "Record a new asset. It gets a unique tag automatically.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid max-h-[60vh] grid-cols-1 gap-x-4 gap-y-3 overflow-y-auto border-y p-4 sm:grid-cols-2">
            {mode === "edit" && editTag && (
              <Field label="Tag" className="sm:col-span-2">
                <Input
                  value={editTag}
                  disabled
                  readOnly
                  className="font-mono"
                />
                <Hint icon>Generated at create · never changes</Hint>
              </Field>
            )}

            <Field label="Name" required error={errors.name}>
              <Input
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Sarah's MacBook Pro"
                aria-invalid={!!errors.name}
                autoFocus={mode === "create"}
              />
            </Field>

            <Field
              label={
                mode === "edit" ? "Type (locked)" : "Type"
              }
              required
              error={errors.type}
            >
              <Select
                value={values.type || null}
                onValueChange={(v) => set("type", v as AssetType)}
                disabled={mode === "edit"}
              >
                <SelectTrigger
                  className="w-full"
                  aria-invalid={!!errors.type}
                >
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {ASSET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {mode === "edit" && (
                <Hint icon>Set at create; delete and re-create to change</Hint>
              )}
            </Field>

            <Field label="Status" required error={errors.status}>
              <Select
                value={values.status || null}
                onValueChange={(v) => set("status", v as AssetFormValues["status"])}
              >
                <SelectTrigger
                  className="w-full"
                  aria-invalid={!!errors.status}
                >
                  <SelectValue placeholder="Choose a status" />
                </SelectTrigger>
                <SelectContent>
                  {ASSET_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Assignee">
              <Select
                value={values.assigneeId}
                onValueChange={(v) => set("assigneeId", v ?? "")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Available (unassigned)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Available (unassigned)</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Serial">
              <Input
                value={values.serial}
                onChange={(e) => set("serial", e.target.value)}
                className="font-mono"
              />
            </Field>

            <Field label="Model">
              <Input
                value={values.model}
                onChange={(e) => set("model", e.target.value)}
              />
            </Field>

            <Field label="Location">
              <Input
                value={values.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder="e.g. SF — HQ — L4"
              />
            </Field>

            <Field label="Vendor">
              <Input
                value={values.vendor}
                onChange={(e) => set("vendor", e.target.value)}
              />
            </Field>

            <Field label="Cost center">
              <Input
                value={values.costCenter}
                onChange={(e) => set("costCenter", e.target.value)}
              />
            </Field>

            <Field label="Purchase date" error={errors.purchaseDate}>
              <Input
                type="date"
                value={values.purchaseDate}
                onChange={(e) => set("purchaseDate", e.target.value)}
                aria-invalid={!!errors.purchaseDate}
              />
            </Field>

            <Field label="Warranty until" error={errors.warrantyUntil}>
              <Input
                type="date"
                value={values.warrantyUntil}
                onChange={(e) => set("warrantyUntil", e.target.value)}
                aria-invalid={!!errors.warrantyUntil}
              />
            </Field>

            <Field label="Specification" className="sm:col-span-2">
              <Textarea
                value={values.spec}
                onChange={(e) => set("spec", e.target.value)}
                placeholder="e.g. 64GB RAM / 2TB SSD"
                rows={2}
              />
            </Field>
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
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {mode === "edit" ? "Save changes" : "Create asset"}
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

function Hint({
  icon,
  children,
}: {
  icon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      {icon && <Lock className="size-3" />}
      {children}
    </span>
  );
}
