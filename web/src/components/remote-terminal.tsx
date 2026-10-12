"use client";

import "@xterm/xterm/css/xterm.css";

import * as React from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";

import {
  endRemoteSessionAction,
  startRemoteSessionAction,
} from "@/app/(app)/remote-actions";
import { Button } from "@/components/ui/button";

type UiStatus =
  | "idle"
  | "pending"
  | "claimed"
  | "active"
  | "closing"
  | "closed"
  | "failed"
  | "canceled"
  | "error";

const STATUS_LABEL: Record<UiStatus, string> = {
  idle: "No session",
  pending: "Waiting for collector…",
  claimed: "Connecting…",
  active: "Connected",
  closing: "Closing…",
  closed: "Session ended",
  failed: "Session failed",
  canceled: "Canceled",
  error: "Error",
};

// A dot color per state for the status pill.
const STATUS_DOT: Record<UiStatus, string> = {
  idle: "bg-slate-500",
  pending: "bg-amber-400",
  claimed: "bg-amber-400",
  active: "bg-emerald-400",
  closing: "bg-amber-400",
  closed: "bg-slate-500",
  failed: "bg-red-500",
  canceled: "bg-slate-500",
  error: "bg-red-500",
};

// GitHub-dark-ish palette — a full ANSI set so program output (ls, git, errors)
// renders in sensible colors instead of plain white.
const TERM_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#2d4f76",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

/**
 * Remote Actions interactive terminal (spec 24). Opens a session on demand, streams
 * output over SSE, and sends typed input back over the relay. It is a streaming
 * command REPL (one line per Enter), not a raw PTY — see the spec. xterm is
 * dynamically imported so it never runs during SSR. Only rendered for a
 * `remote:shell` admin.
 */
export function RemoteTerminal({ assetTag }: { assetTag: string }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- xterm types load at runtime
  const termRef = React.useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitRef = React.useRef<any>(null);
  const roRef = React.useRef<ResizeObserver | null>(null);
  const esRef = React.useRef<EventSource | null>(null);
  const lineRef = React.useRef("");
  const sessionIdRef = React.useRef<string | null>(null);

  const [status, setStatus] = React.useState<UiStatus>("idle");
  const [busy, setBusy] = React.useState(false);

  const statusRef = React.useRef<UiStatus>("idle");
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const write = (s: string) => termRef.current?.write(s);
  const writeLine = (s: string) => termRef.current?.write(`\r\n${s}\r\n`);
  // Echo the user's own typed characters in bold so the command stands out from
  // the program's output, the way a themed shell does.
  const echo = (s: string) => termRef.current?.write(`\x1b[1m${s}\x1b[22m`);

  // Re-measure the grid to the container and keep the newest line in view. Safe to
  // call often; it no-ops before the terminal exists.
  const refit = React.useCallback(() => {
    try {
      fitRef.current?.fit();
      termRef.current?.scrollToBottom();
    } catch {
      /* container not laid out yet */
    }
  }, []);

  const teardownStream = React.useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  // Local line editor: echo printable chars, send the line on Enter.
  const onData = React.useCallback((data: string) => {
    if (statusRef.current !== "active") return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        const line = lineRef.current;
        lineRef.current = "";
        write("\r\n");
        void sendInput(line);
      } else if (code === 127 || ch === "\b") {
        if (lineRef.current.length) {
          lineRef.current = lineRef.current.slice(0, -1);
          write("\b \b");
        }
      } else if (code === 3) {
        lineRef.current = "";
        write("^C\r\n");
      } else if (code >= 32) {
        lineRef.current += ch;
        echo(ch);
      }
    }
    termRef.current?.scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ensure the xterm instance exists (dynamic import, client-only).
  const ensureTerminal = React.useCallback(async () => {
    if (termRef.current || !hostRef.current) return;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      // 'Segoe UI Symbol' is a fallback so the robbyrussell ➜ (U+279C) renders on
      // Windows, where the default mono fonts (Consolas) lack that dingbat.
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Segoe UI Symbol', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 2000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.onData(onData);
    termRef.current = term;
    fitRef.current = fit;

    // Fit after the browser has laid the container out, and again once the web
    // font has loaded (cell metrics change) — otherwise the last row is clipped.
    requestAnimationFrame(() => requestAnimationFrame(refit));
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(refit).catch(() => {});
    }
    const ro = new ResizeObserver(refit);
    ro.observe(hostRef.current);
    roRef.current = ro;
  }, [onData, refit]);

  const sendInput = async (text: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await fetch(`/api/remote/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      writeLine("\x1b[31m[failed to send input]\x1b[0m");
    }
  };

  const openStream = (id: string) => {
    teardownStream();
    const es = new EventSource(`/api/remote/sessions/${id}/stream`);
    esRef.current = es;
    es.addEventListener("output", (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as {
          channel: string | null;
          data: string;
        };
        if (e.channel === "stderr") write(`\x1b[31m${e.data}\x1b[0m`);
        else write(e.data);
        termRef.current?.scrollToBottom();
      } catch {
        /* ignore malformed frame */
      }
    });
    es.addEventListener("status", (ev) => {
      try {
        const { status: s } = JSON.parse((ev as MessageEvent).data) as {
          status: UiStatus;
        };
        setStatus(s);
        if (s === "active") {
          writeLine("\x1b[32m— connected —\x1b[0m");
          refit();
          termRef.current?.focus();
        }
        if (s === "failed") writeLine("\x1b[31m— session failed —\x1b[0m");
        if (s === "closed" || s === "canceled") {
          writeLine("\x1b[33m— session ended —\x1b[0m");
          teardownStream();
        }
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      if (["closed", "failed", "canceled"].includes(statusRef.current)) {
        teardownStream();
      }
    };
  };

  const start = async () => {
    setBusy(true);
    try {
      await ensureTerminal();
      termRef.current?.clear();
      refit();
      const res = await startRemoteSessionAction(assetTag);
      if (!res.ok) {
        toast.error(res.error);
        setStatus("error");
        return;
      }
      sessionIdRef.current = res.sessionId;
      setStatus("pending");
      writeLine("\x1b[90mStarting remote session…\x1b[0m");
      openStream(res.sessionId);
      termRef.current?.focus();
    } catch {
      toast.error("Could not start the session.");
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    setBusy(true);
    try {
      const res = await endRemoteSessionAction(id);
      if (!res.ok) toast.error(res.error);
      setStatus("closing");
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => {
    const onResize = () => refit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      roRef.current?.disconnect();
      roRef.current = null;
      teardownStream();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [refit, teardownStream]);

  const live = status === "pending" || status === "claimed" || status === "active";
  const spinning =
    status === "pending" || status === "claimed" || status === "closing";

  return (
    <div className="overflow-hidden rounded-xl border bg-[#0d1117] shadow-sm">
      {/* Terminal chrome: window dots, target, status pill, session control. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#161b22] px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="size-3 rounded-full bg-[#ff5f56]" />
            <span className="size-3 rounded-full bg-[#ffbd2e]" />
            <span className="size-3 rounded-full bg-[#27c93f]" />
          </div>
          <span className="font-mono text-xs text-slate-300">
            {assetTag} — PowerShell
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-300">
            <span
              className={`size-2 rounded-full ${STATUS_DOT[status]} ${
                status === "active" ? "animate-pulse" : ""
              }`}
            />
            {STATUS_LABEL[status]}
          </span>
          {live ? (
            <Button variant="outline" size="sm" onClick={end} disabled={busy}>
              <Square className="size-4" /> End
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Start session
            </Button>
          )}
        </div>
      </div>

      {/* Padded host; the inner div is the exact fit target (no padding) so the
          grid measures cleanly and the prompt row is never clipped. */}
      <div className="h-[460px] bg-[#0d1117] p-3">
        <div ref={hostRef} className="h-full w-full" aria-label="Remote terminal" />
      </div>

      <div className="border-t border-white/10 bg-[#161b22] px-3 py-1.5 text-[11px] text-slate-400">
        {status === "idle"
          ? "Start a session to open a live PowerShell terminal on this computer. Every session is recorded."
          : "Interactive PowerShell — command streaming, not a full TTY. Each line runs as its own command."}
        {spinning && <Loader2 className="ml-2 inline size-3 animate-spin" />}
      </div>
    </div>
  );
}
