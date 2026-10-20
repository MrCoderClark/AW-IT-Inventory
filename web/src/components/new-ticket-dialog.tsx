"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createTicketAction } from "@/app/(app)/ticket-actions";
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
import type { TicketPriority } from "@/lib/data";
import { createTicketInputSchema } from "@/lib/ticket-schema";
import { TICKET_PRIORITY_LABEL } from "@/lib/ticket-ui";

const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

type FormState = {
  subject: string;
  description: string;
  priority: TicketPriority;
  category: string;
  assigneeEmail: string;
};

const EMPTY: FormState = {
  subject: "",
  description: "",
  priority: "medium",
  category: "",
  assigneeEmail: "",
};

export function NewTicketDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new ticket id after a successful create. */
  onCreated?: (ticketId: string | undefined) => void;
}) {
  const [values, setValues] = React.useState<FormState>(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setValues(EMPTY);
    setError(null);
  }, [open]);

  function submit() {
    const assigneeRaw = values.assigneeEmail.trim();
    const parsed = createTicketInputSchema.safeParse({
      subject: values.subject,
      description: values.description || undefined,
      priority: values.priority,
      category: values.category.trim() || undefined,
      assigneeEmail: assigneeRaw ? assigneeRaw : null,
      assetId: null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await createTicketAction(parsed.data);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      onOpenChange(false);
      onCreated?.(res.ticketId);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Open a service ticket for the IT team. Link an asset later from a
            notification or when editing is expanded in a future release.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4 px-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="grid gap-1.5 text-sm">
            Subject
            <Input
              id="ticket-subject"
              value={values.subject}
              onChange={(e) =>
                setValues((v) => ({ ...v, subject: e.target.value }))
              }
              autoFocus
            />
          </label>

          <label className="grid gap-1.5 text-sm">
            Description
            <Textarea
              id="ticket-description"
              value={values.description}
              onChange={(e) =>
                setValues((v) => ({ ...v, description: e.target.value }))
              }
              rows={4}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              Priority
              <Select
                value={values.priority}
                onValueChange={(v) =>
                  setValues((s) => ({
                    ...s,
                    priority: v as TicketPriority,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TICKET_PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm">
              Category
              <Input
                id="ticket-category"
                value={values.category}
                onChange={(e) =>
                  setValues((v) => ({ ...v, category: e.target.value }))
                }
                placeholder="General"
              />
            </label>
          </div>

          <label className="grid gap-1.5 text-sm">
            Assignee email
            <Input
              id="ticket-assignee"
              type="email"
              value={values.assigneeEmail}
              onChange={(e) =>
                setValues((v) => ({ ...v, assigneeEmail: e.target.value }))
              }
              placeholder="Optional"
            />
          </label>

          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
