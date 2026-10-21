"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createTicketAction } from "@/app/(app)/ticket-actions";
import { TicketAssetPicker } from "@/components/ticket-asset-picker";
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
import type { LinkAsset, TicketPriority } from "@/lib/data";
import { createTicketInputSchema } from "@/lib/ticket-schema";
import {
  TICKET_CATEGORIES,
  type TicketCategory,
  TICKET_PRIORITY_LABEL,
} from "@/lib/ticket-ui";

const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

type FormState = {
  subject: string;
  description: string;
  priority: TicketPriority;
  category: TicketCategory;
  assigneeEmail: string;
  requesterEmail: string;
  assetId: string | null;
};

const EMPTY: FormState = {
  subject: "",
  description: "",
  priority: "medium",
  category: "General",
  assigneeEmail: "",
  requesterEmail: "",
  assetId: null,
};

export function NewTicketDialog({
  open,
  onOpenChange,
  onCreated,
  linkAssets = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new ticket id after a successful create. */
  onCreated?: (ticketId: string | undefined) => void;
  linkAssets?: LinkAsset[];
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
    const requesterRaw = values.requesterEmail.trim();
    const parsed = createTicketInputSchema.safeParse({
      subject: values.subject,
      description: values.description || undefined,
      priority: values.priority,
      category: values.category,
      assigneeEmail: assigneeRaw ? assigneeRaw : null,
      requesterEmail: requesterRaw ? requesterRaw : null,
      assetId: values.assetId,
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
      <DialogContent className="flex max-h-[min(92vh,44rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Create a service ticket. Linking an asset fills location and can set
            the requester from the device owner.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(17rem,1fr)] lg:items-start">
              {/* Main column — subject + description */}
              <div className="flex flex-col gap-4">
                <label className="grid gap-1.5 text-sm font-medium">
                  Subject
                  <Input
                    id="ticket-subject"
                    value={values.subject}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, subject: e.target.value }))
                    }
                    placeholder="Short summary of the issue"
                    autoFocus
                    className="font-normal"
                  />
                </label>

                <label className="grid gap-1.5 text-sm font-medium">
                  Description
                  <Textarea
                    id="ticket-description"
                    value={values.description}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, description: e.target.value }))
                    }
                    rows={12}
                    placeholder="Details, steps to reproduce, impact…"
                    className="min-h-[12rem] resize-y font-normal"
                  />
                </label>
              </div>

              {/* Side column — classification + people + asset */}
              <aside className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4">
                <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  Details
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1.5 text-sm font-medium">
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
                      <SelectTrigger className="w-full bg-background font-normal">
                        <SelectValue>
                          {TICKET_PRIORITY_LABEL[values.priority]}
                        </SelectValue>
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

                  <label className="grid gap-1.5 text-sm font-medium">
                    Category
                    <Select
                      value={values.category}
                      onValueChange={(v) =>
                        setValues((s) => ({
                          ...s,
                          category: v as TicketCategory,
                        }))
                      }
                    >
                      <SelectTrigger
                        id="ticket-category"
                        className="w-full bg-background font-normal"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TICKET_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>

                <label className="grid gap-1.5 text-sm font-medium">
                  Requester
                  <Input
                    id="ticket-requester"
                    type="email"
                    value={values.requesterEmail}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        requesterEmail: e.target.value,
                      }))
                    }
                    placeholder="End user / device owner"
                    className="bg-background font-normal"
                  />
                </label>

                <label className="grid gap-1.5 text-sm font-medium">
                  Assignee
                  <Input
                    id="ticket-assignee"
                    type="email"
                    value={values.assigneeEmail}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        assigneeEmail: e.target.value,
                      }))
                    }
                    placeholder="IT owner (optional)"
                    className="bg-background font-normal"
                  />
                </label>

                <div className="grid gap-1.5 text-sm font-medium">
                  <span>Linked asset</span>
                  <div className="rounded-lg border bg-background p-2 font-normal">
                    <TicketAssetPicker
                      assets={linkAssets}
                      value={values.assetId}
                      onChange={(assetId) => {
                        const owner = assetId
                          ? linkAssets.find((a) => a.id === assetId)?.ownerEmail
                          : null;
                        setValues((v) => ({
                          ...v,
                          assetId,
                          ...(owner ? { requesterEmail: owner } : {}),
                        }));
                      }}
                      disabled={isPending}
                    />
                  </div>
                </div>
              </aside>
            </div>

            {error ? (
              <p className="text-destructive mt-4 text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t px-6 py-4 sm:justify-end">
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
