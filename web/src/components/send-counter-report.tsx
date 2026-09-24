"use client";

import * as React from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { sendCounterReportNow } from "@/app/(app)/counter-report-actions";
import { Button } from "@/components/ui/button";

/**
 * "Send counter report now" button on the Admin page (spec 14, AC-5). Fires the
 * `scan:write`-gated server action, which runs the same shared report send as the
 * worker's daily job. Only rendered for a `scan:write` admin — a user without it
 * never sees this button, and the action refuses the call server-side too.
 */
export function SendCounterReport() {
  const [pending, startTransition] = React.useTransition();

  function send() {
    startTransition(async () => {
      const res = await sendCounterReportNow();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <Button variant="outline" onClick={send} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Send className="size-4" />
      )}
      Send counter report now
    </Button>
  );
}
