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
import {
  TYPE_FIELDS,
  detailsFieldErrors,
  detailsSchemaFor,
  emptyDetailsFor,
  type DetailsFormValues,
  type TypeField,
} from "@/lib/asset-fields";
import {
  STATUS_META,
  type AssetType,
  type LocationOption,
} from "@/lib/data";
import { cn } from "@/lib/utils";

export interface PersonOption {
  id: string;
  name: string;
}

type FieldErrors = Partial<Record<keyof AssetFormValues, string>>;

/**
 * Shared fields a type hides (e.g. Assignee for Printer / Network), from the
 * per-type field registry (spec 10). Hidden in the UI and cleared on submit so a
 * type switch can't leave a stray value (e.g. an assignee on a printer).
 */
function hiddenFieldsFor(type: AssetType | ""): Set<keyof AssetFormValues> {
  return new Set(type ? TYPE_FIELDS[type].hiddenShared : []);
}

export function AssetFormDialog({
  open,
  onOpenChange,
  mode,
  people,
  locations = [],
  presetType,
  editTag,
  initial,
  initialDetails,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  people: PersonOption[];
  /** Assignable leaf locations for the location picker, by full path. */
  locations?: LocationOption[];
  /** Create mode: pre-select the type (a category page). */
  presetType?: AssetType;
  /** Edit mode: the immutable tag being edited. */
  editTag?: string;
  /** Edit mode: the asset's current values, pre-filled into the form. */
  initial?: AssetFormValues;
  /** Edit mode: the asset's current type-specific values, pre-filled. */
  initialDetails?: DetailsFormValues;
  onSuccess?: () => void;
}) {
  const [values, setValues] = React.useState<AssetFormValues>(EMPTY_ASSET_FORM);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  // Type-specific field values (all strings) and their inline errors.
  const [details, setDetails] = React.useState<DetailsFormValues>({});
  const [detailErrors, setDetailErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [isPending, startTransition] = React.useTransition();

  const hidden = hiddenFieldsFor(values.type);
  const typeFields = values.type ? TYPE_FIELDS[values.type].fields : [];

  // Reset the form each time the dialog opens, to the edit values or a fresh
  // create form (with the category's type pre-selected).
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setDetailErrors({});
    if (mode === "edit" && initial) {
      setValues(initial);
      setDetails(initialDetails ?? emptyDetailsFor(initial.type as AssetType));
    } else {
      const t = presetType ?? "";
      setValues({ ...EMPTY_ASSET_FORM, type: t });
      setDetails(t ? emptyDetailsFor(t) : {});
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

  // Create mode only: switching type swaps the type-specific field set.
  function setType(next: AssetType) {
    set("type", next);
    setDetails(emptyDetailsFor(next));
    setDetailErrors({});
  }

  function setDetail(key: string, value: string) {
    setDetails((d) => ({ ...d, [key]: value }));
    if (detailErrors[key])
      setDetailErrors((e) => {
        const n = { ...e };
        delete n[key];
        return n;
      });
  }

  function submit() {
    // Drop any values for fields hidden by the chosen type before validating.
    const cleaned: AssetFormValues = { ...values };
    for (const key of hidden) cleaned[key] = "";

    const parsed = assetInputSchema.safeParse(cleaned);
    if (!parsed.success) setErrors(fieldErrors(parsed.error));

    const detailsParsed = cleaned.type
      ? detailsSchemaFor(cleaned.type).safeParse(details)
      : null;
    if (detailsParsed && !detailsParsed.success)
      setDetailErrors(detailsFieldErrors(detailsParsed.error));

    if (!parsed.success || (detailsParsed && !detailsParsed.success)) return;

    // Submit the raw detail strings alongside the shared fields; the action
    // re-parses both at the trust boundary.
    const payload = { ...cleaned, details };
    startTransition(async () => {
      const res =
        mode === "edit" && editTag
          ? await updateAsset(editTag, payload)
          : await createAsset(payload);
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
                onValueChange={(v) => setType(v as AssetType)}
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

            {!hidden.has("assigneeId") && (
              <Field label="Assignee">
                <Select
                  value={values.assigneeId}
                  onValueChange={(v) => set("assigneeId", v ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Available (unassigned)" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Empty string is the "unassigned" sentinel; the schema
                       coerces it to null. Safe here because assigneeId is a UUID,
                       so "" is never a real value. Don't copy value="" into a
                       select whose domain could include an empty string. */}
                    <SelectItem value="">Available (unassigned)</SelectItem>
                    {people.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

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
              <Select
                value={values.locationId}
                onValueChange={(v) => set("locationId", v ?? "")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No location" />
                </SelectTrigger>
                <SelectContent>
                  {/* "" is the "No location" sentinel; the schema coerces it to
                     null. Only leaves are listed — assignment is leaf-only. */}
                  <SelectItem value="">No location</SelectItem>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {locations.length === 0 && (
                <Hint>No leaf locations yet — add them on the Locations page.</Hint>
              )}
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

            {/* Type-specific fields, from the per-type registry (spec 10). */}
            {typeFields.length > 0 && (
              <div className="sm:col-span-2 mt-1 border-t pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {values.type} details
              </div>
            )}
            {typeFields.map((f) => (
              <DetailField
                key={f.key}
                field={f}
                value={details[f.key] ?? ""}
                error={detailErrors[f.key]}
                onChange={(v) => setDetail(f.key, v)}
              />
            ))}
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

/** Render one type-specific field from the registry: a select, or an input
   (numeric for int/decimal). Its value and error are plain strings. */
function DetailField({
  field,
  value,
  error,
  onChange,
}: {
  field: TypeField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  if (field.kind === "select") {
    return (
      <Field label={field.label} required={field.required} error={error}>
        <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
          <SelectTrigger className="w-full" aria-invalid={!!error}>
            <SelectValue placeholder={`Choose ${field.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {!field.required && <SelectItem value="">—</SelectItem>}
            {field.options?.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }
  const numeric = field.kind === "int" || field.kind === "decimal";
  return (
    <Field label={field.label} required={field.required} error={error}>
      <Input
        type={numeric ? "number" : "text"}
        inputMode={
          field.kind === "int"
            ? "numeric"
            : field.kind === "decimal"
              ? "decimal"
              : undefined
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        aria-invalid={!!error}
      />
    </Field>
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
