"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  createAlertRuleAction,
  updateAlertRuleAction,
} from "@/app/(app)/alert-rule-actions";
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
import type { AlertRuleRecord } from "@/lib/alert-rules";
import { OP_LABEL, SIGNAL_LABEL, SEVERITY_LABEL } from "@/lib/alert-rules";
import {
  ALERT_SEVERITIES,
  EMPTY_ALERT_RULE_FORM,
  METRIC_OPS,
  METRIC_SIGNALS,
  alertRuleInputSchema,
  fieldErrors,
  type AlertRuleFormValues,
} from "@/lib/alert-rule-schema";
import { cn } from "@/lib/utils";

type FieldErrors = Partial<Record<keyof AlertRuleFormValues, string>>;

function valuesFrom(rule: AlertRuleRecord | null): AlertRuleFormValues {
  if (!rule) return EMPTY_ALERT_RULE_FORM;
  return {
    name: rule.name,
    signal: rule.signal,
    op: rule.op,
    threshold: String(rule.threshold),
    consecutive: String(rule.consecutive),
    severity: rule.severity,
  };
}

export function AlertRuleFormDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this row; otherwise it creates. */
  rule: AlertRuleRecord | null;
}) {
  const [values, setValues] = React.useState<AlertRuleFormValues>(
    EMPTY_ALERT_RULE_FORM,
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [isPending, startTransition] = React.useTransition();
  const editing = !!rule;

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setValues(valuesFrom(rule));
  }, [open, rule]);

  function set<K extends keyof AlertRuleFormValues>(
    key: K,
    value: AlertRuleFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit() {
    const parsed = alertRuleInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<keyof AlertRuleFormValues>(parsed.error));
      return;
    }
    startTransition(async () => {
      const res = editing
        ? await updateAlertRuleAction(rule.id, parsed.data)
        : await createAlertRuleAction(parsed.data);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>{editing ? "Edit alert rule" : "New alert rule"}</DialogTitle>
          <DialogDescription>
            Fires when the last N readable samples all match the condition. Gaps
            (a missing reading) are skipped, not treated as zero.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-3 border-y p-4">
            <Field label="Name" required error={errors.name}>
              <Input
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Disk almost full"
                aria-invalid={!!errors.name}
                autoFocus
                maxLength={80}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Signal" required error={errors.signal}>
                <Select
                  value={values.signal}
                  onValueChange={(v) =>
                    set("signal", v as AlertRuleFormValues["signal"])
                  }
                >
                  <SelectTrigger className="w-full" aria-invalid={!!errors.signal}>
                    <SelectValue>
                      {(value) =>
                        SIGNAL_LABEL[value as AlertRuleFormValues["signal"]] ??
                        "Choose a signal"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_SIGNALS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {SIGNAL_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Operator" required error={errors.op}>
                <Select
                  value={values.op}
                  onValueChange={(v) =>
                    set("op", v as AlertRuleFormValues["op"])
                  }
                >
                  <SelectTrigger className="w-full" aria-invalid={!!errors.op}>
                    <SelectValue>
                      {(value) =>
                        OP_LABEL[value as AlertRuleFormValues["op"]] ??
                        "Choose an operator"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_OPS.map((op) => (
                      <SelectItem key={op} value={op}>
                        {OP_LABEL[op]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Threshold" required error={errors.threshold}>
                <Input
                  type="number"
                  value={values.threshold}
                  onChange={(e) => set("threshold", e.target.value)}
                  aria-invalid={!!errors.threshold}
                />
              </Field>

              <Field
                label="Consecutive samples"
                required
                error={errors.consecutive}
              >
                <Input
                  type="number"
                  min={1}
                  max={48}
                  value={values.consecutive}
                  onChange={(e) => set("consecutive", e.target.value)}
                  aria-invalid={!!errors.consecutive}
                />
              </Field>
            </div>

            <Field label="Severity" required error={errors.severity}>
              <Select
                value={values.severity}
                onValueChange={(v) =>
                  set("severity", v as AlertRuleFormValues["severity"])
                }
              >
                <SelectTrigger className="w-full" aria-invalid={!!errors.severity}>
                  <SelectValue>
                    {(value) =>
                      SEVERITY_LABEL[
                        value as AlertRuleFormValues["severity"]
                      ] ?? "Choose a severity"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ALERT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SEVERITY_LABEL[s]}
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
              {editing ? "Save rule" : "Create rule"}
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
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {error && (
        <span className={cn("text-xs text-destructive")}>{error}</span>
      )}
    </label>
  );
}
