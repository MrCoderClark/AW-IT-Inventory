"use client";

import * as React from "react";
import { Loader2, ScrollText } from "lucide-react";
import { toast } from "sonner";

import { Panel } from "@/components/detail-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type RemoteSessionHistoryItem = {
  id: string;
  status: "pending" | "claimed" | "active" | "closing" | "closed" | "failed" | "canceled";
  requestedBy: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type TranscriptEvent = {
  seq: number;
  direction: "input" | "output" | "system";
  channel: "stdout" | "stderr" | "status" | null;
  data: string;
};

// Strip ANSI escape sequences (colours, cursor moves) so the transcript reads as
// plain text in a <pre> rather than showing raw escape codes.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function statusBadge(status: RemoteSessionHistoryItem["status"]) {
  if (status === "active" || status === "claimed" || status === "pending")
    return <Badge className="gap-1">Live</Badge>;
  if (status === "closed") return <Badge variant="secondary">Closed</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "closing") return <Badge variant="secondary">Closing</Badge>;
  return <Badge variant="outline">Canceled</Badge>;
}

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Past remote-terminal sessions for this computer (spec 24, AC-7): who ran one,
 * when, how long, and its outcome — with a transcript viewer (the recorded
 * input + output). Only rendered for a `remote:shell` admin; the transcript
 * endpoint re-checks ownership.
 */
export function RemoteSessionHistory({
  sessions,
}: {
  sessions: RemoteSessionHistoryItem[];
}) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [transcript, setTranscript] = React.useState<string>("");

  async function open(id: string) {
    setOpenId(id);
    setLoading(true);
    setTranscript("");
    try {
      const res = await fetch(`/api/remote/sessions/${id}/transcript`);
      if (!res.ok) {
        toast.error("Could not load the transcript.");
        setOpenId(null);
        return;
      }
      const data = (await res.json()) as { events: TranscriptEvent[] };
      const text = data.events
        .map((e) =>
          e.direction === "input" ? `❯ ${e.data}\n` : stripAnsi(e.data),
        )
        .join("");
      setTranscript(text || "(no output recorded)");
    } catch {
      toast.error("Could not load the transcript.");
      setOpenId(null);
    } finally {
      setLoading(false);
    }
  }

  if (sessions.length === 0) return null;

  return (
    <Panel icon={<ScrollText />} title="Session history">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{statusBadge(s.status)}</TableCell>
                <TableCell className="text-muted-foreground">{s.requestedBy}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(s.startedAt ?? s.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {duration(s.startedAt, s.endedAt)}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => open(s.id)}>
                    Transcript
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Session transcript</DialogTitle>
          </DialogHeader>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-[#0d1117] p-3 text-xs whitespace-pre-wrap text-slate-200">
              {transcript}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
