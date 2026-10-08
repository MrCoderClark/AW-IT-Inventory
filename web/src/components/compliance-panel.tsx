import { ShieldCheck } from "lucide-react";

import { Dot, Panel, StatusRow, fmtDateTime } from "@/components/detail-ui";
import {
  scoreCompliance,
  type CheckStatus,
  type CompliancePosture,
} from "@/lib/compliance-score";

/* Per-device compliance / health (spec 21, phase 2). Pure render over the stored
   posture: the score + 🟢🟡🔴 check rows, plus the "limited visibility" and
   "not assessed" states. Scoring is derived here via scoreCompliance. */

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: "var(--status-online)",
  warn: "var(--status-maintenance)",
  fail: "var(--status-down)",
  unknown: "var(--status-storage)",
};

function scoreColor(score: number): string {
  if (score >= 80) return "var(--status-online)";
  if (score >= 50) return "var(--status-maintenance)";
  return "var(--status-down)";
}

export function CompliancePanel({
  posture,
}: {
  posture: CompliancePosture | null;
}) {
  // No row at all → never scanned for posture yet.
  if (!posture) {
    return (
      <Panel icon={<ShieldCheck />} title="Compliance & health">
        <p className="text-sm text-muted-foreground">
          No posture data yet. Scan this computer to assess BitLocker, antivirus,
          TPM, Secure Boot, Windows Update, and disk health.
        </p>
      </Panel>
    );
  }

  const result = scoreCompliance(posture);

  return (
    <Panel icon={<ShieldCheck />} title="Compliance & health">
      <div className="mb-4 flex items-end justify-between gap-4">
        {result.assessed ? (
          <div className="flex items-baseline gap-1">
            <span
              className="text-3xl font-semibold tabular-nums"
              style={{ color: scoreColor(result.score as number) }}
            >
              {result.score}
            </span>
            <span className="text-sm text-muted-foreground">/ 100</span>
          </div>
        ) : (
          <div className="max-w-prose">
            <p className="text-lg font-semibold">Not assessed</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              None of the posture signals could be read — this usually means the
              scan account lacks a full admin token. Enable remote admin
              (<code>LocalAccountTokenFilterPolicy</code> / GPO) and re-scan. See the
              onboarding runbook.
            </p>
          </div>
        )}
        {posture.assessedAt && (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            Assessed {fmtDateTime(posture.assessedAt)}
          </span>
        )}
      </div>

      {result.assessed && result.unknownCount > 0 && (
        <p className="mb-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Limited visibility — {result.unknownCount} signal
          {result.unknownCount === 1 ? "" : "s"} couldn&apos;t be read (often a
          UAC-filtered token; see the onboarding runbook). Unreadable checks count
          as failing, not passing.
        </p>
      )}

      <div className="divide-y">
        {result.checks.map((c) => (
          <StatusRow key={c.id} label={c.label}>
            <Dot color={STATUS_COLOR[c.status]}>{c.detail}</Dot>
          </StatusRow>
        ))}
      </div>

      {posture.localAdmins && posture.localAdmins.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Local administrators ({posture.localAdmins.length})
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {posture.localAdmins.map((a) => (
              <li
                key={a.name}
                className={`inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs ${
                  a.enabled ? "" : "opacity-60"
                }`}
              >
                <span className={a.enabled ? "" : "line-through"}>{a.name}</span>
                {a.isGroup && (
                  <span className="rounded bg-primary/10 px-1 font-sans text-[10px] font-medium text-primary">
                    group
                  </span>
                )}
                {!a.enabled && (
                  <span className="rounded bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground">
                    disabled
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
