"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  createPersonAction,
  updatePersonAction,
} from "@/app/(app)/people-actions";
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
import {
  EMPTY_PERSON_FORM,
  personFieldErrors,
  personInputSchema,
  type PersonFormValues,
} from "@/lib/person-schema";
import type { LocationOption } from "@/lib/data";
import { cn } from "@/lib/utils";

type FieldErrors = Partial<Record<keyof PersonFormValues, string>>;

export function PersonFormDialog({
  open,
  onOpenChange,
  mode,
  locations = [],
  editId,
  initial,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** All location nodes (a person may sit at any node, not just a leaf). */
  locations?: LocationOption[];
  /** Edit mode: the person id being edited. */
  editId?: string;
  /** Edit mode: the person's current values, pre-filled. */
  initial?: PersonFormValues;
  onSuccess?: () => void;
}) {
  const [values, setValues] = React.useState<PersonFormValues>(EMPTY_PERSON_FORM);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setValues(mode === "edit" && initial ? initial : EMPTY_PERSON_FORM);
    // initial is captured on open; re-running on its identity would clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  function set<K extends keyof PersonFormValues>(
    key: K,
    value: PersonFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit() {
    const parsed = personInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(personFieldErrors(parsed.error));
      return;
    }
    startTransition(async () => {
      const res =
        mode === "edit" && editId
          ? await updatePersonAction(editId, values)
          : await createPersonAction(values);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.error);
      }
    });
  }

  const title = mode === "edit" ? "Edit person" : "New person";
  const description =
    mode === "edit"
      ? "Update this person's details. Initials are derived from the name."
      : "Add someone to the directory. Only a name is required.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-xl">
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
            <Field
              label="Name"
              required
              error={errors.name}
              className="sm:col-span-2"
            >
              <Input
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Sarah Jenkins"
                aria-invalid={!!errors.name}
                autoFocus
              />
            </Field>

            <Field label="Email" error={errors.email}>
              <Input
                type="email"
                value={values.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="name@company.com"
                aria-invalid={!!errors.email}
              />
            </Field>

            <Field label="Phone">
              <Input
                value={values.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </Field>

            <Field label="Department">
              <Input
                value={values.department}
                onChange={(e) => set("department", e.target.value)}
              />
            </Field>

            <Field label="Job title">
              <Input
                value={values.jobTitle}
                onChange={(e) => set("jobTitle", e.target.value)}
              />
            </Field>

            <Field label="Employee id">
              <Input
                value={values.employeeId}
                onChange={(e) => set("employeeId", e.target.value)}
                className="font-mono"
              />
            </Field>

            <Field label="Office location">
              <Select
                value={values.officeLocationId}
                onValueChange={(v) => set("officeLocationId", v ?? "")}
              >
                <SelectTrigger className="w-full">
                  {/* Base UI Select.Value falls back to the raw value (a uuid)
                     once the popup closes; map it back to the location path. */}
                  <SelectValue placeholder="No location">
                    {(value) =>
                      locations.find((l) => l.id === value)?.path ?? "No location"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {/* "" clears the location; a person may sit at any node. */}
                  <SelectItem value="">No location</SelectItem>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              {mode === "edit" ? "Save changes" : "Add person"}
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
