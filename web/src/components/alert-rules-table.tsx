"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import {
  deleteAlertRuleAction,
  setAlertRuleEnabledAction,
} from "@/app/(app)/alert-rule-actions";
import {
  AlertRuleFormDialog,
  type AlertRuleScriptOption,
} from "@/components/alert-rule-form-dialog";
import { HeroHeader } from "@/components/hero-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCondition,
  SEVERITY_LABEL,
  SIGNAL_LABEL,
  TICKET_AUTO_CREATE_LABEL,
  type AlertRuleRecord,
} from "@/lib/alert-rules";

function severityVariant(
  severity: AlertRuleRecord["severity"],
): "outline" | "secondary" | "destructive" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "secondary";
  return "outline";
}

export function AlertRulesTable({
  rules,
  scripts,
}: {
  rules: AlertRuleRecord[];
  scripts: AlertRuleScriptOption[];
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AlertRuleRecord | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(rules.map((r) => [r.id, r.enabled])),
  );

  React.useEffect(() => {
    setEnabled(Object.fromEntries(rules.map((r) => [r.id, r.enabled])));
  }, [rules]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(rule: AlertRuleRecord) {
    setEditing(rule);
    setDialogOpen(true);
  }

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setEditing(null);
      router.refresh();
    }
  }

  function toggle(rule: AlertRuleRecord, next: boolean) {
    const prev = enabled[rule.id];
    setEnabled((s) => ({ ...s, [rule.id]: next }));
    setPendingId(rule.id);
    void (async () => {
      const res = await setAlertRuleEnabledAction(rule.id, next);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
        setEnabled((s) => ({ ...s, [rule.id]: prev }));
      }
      setPendingId(null);
    })();
  }

  function remove(rule: AlertRuleRecord) {
    setPendingId(rule.id);
    void (async () => {
      const res = await deleteAlertRuleAction(rule.id);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
      }
      setPendingId(null);
    })();
  }

  return (
    <>
      <HeroHeader
        title="Alert rules"
        subtitle="Thresholds on CPU, memory, disk and uptime. When a condition holds for enough samples, admins get a notification — and may run a library script on the host."
        icon={<TriangleAlert className="size-6" />}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            New rule
          </Button>
        }
      />

      {rules.length === 0 ? (
        <div className="grid place-content-center gap-2 rounded-xl border border-dashed bg-card/50 py-16 text-center">
          <p className="text-sm font-semibold">No alert rules yet</p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Rules watch the metric samples collected from each computer. Create
            one, or wait for the next ingest — the three defaults seed
            automatically when the table is empty.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Auto-create</TableHead>
                <TableHead>On fire</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="w-[1%] text-right"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">{rule.name}</TableCell>
                  <TableCell>{SIGNAL_LABEL[rule.signal]}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatCondition(rule)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={severityVariant(rule.severity)}>
                      {SEVERITY_LABEL[rule.severity]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {TICKET_AUTO_CREATE_LABEL[rule.ticketAutoCreate]}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {rule.remediationScriptName ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {pendingId === rule.id && (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      )}
                      <Switch
                        checked={enabled[rule.id] ?? rule.enabled}
                        disabled={pendingId !== null}
                        onCheckedChange={(next) => toggle(rule, next)}
                        aria-label={`${enabled[rule.id] ?? rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(rule)}
                        aria-label={`Edit ${rule.name}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => remove(rule)}
                        disabled={pendingId === rule.id}
                        aria-label={`Delete ${rule.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertRuleFormDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        rule={editing}
        scripts={scripts}
      />
    </>
  );
}
