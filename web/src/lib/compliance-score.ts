/**
 * Device health score + per-check verdicts (spec 21). Pure and client-safe: the
 * server (ingest/read) and the UI both derive the score from stored posture here,
 * and it is unit-tested in isolation. Nothing is persisted, so the rubric below can
 * change with no migration.
 *
 * Rubric (100-pt total): each check earns its full weight for a 🟢 pass, ~half for
 * a 🟡 warn, and 0 for a 🔴 fail OR an ⚪ unknown (fail-closed — an unreadable
 * signal does not quietly count as healthy, AC-4). A device whose EVERY check is
 * unknown is "not assessed" (score = null, AC-5).
 */

export interface CompliancePosture {
  bitlocker: string | null; // "on" | "off" | null=unknown
  defenderRealtime: boolean | null;
  defenderSigAgeDays: number | null;
  avProduct: string | null;
  tpmReady: boolean | null;
  secureBoot: string | null; // "on" | "off" | null
  updatesLastDays: number | null;
  updatesPending: number | null;
  systemDrivePctUsed: number | null;
  // Informational (not scored in v1): members of the local Administrators group.
  localAdmins?: string[] | null;
  assessedAt?: string | null;
}

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";
export type CheckId =
  | "bitlocker"
  | "antivirus"
  | "updates"
  | "tpm"
  | "secureBoot"
  | "disk";

export interface ComplianceCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  weight: number;
  earned: number;
  detail: string;
}

export interface ComplianceScore {
  assessed: boolean; // false when every check is unknown
  score: number | null; // 0–100, or null when not assessed
  checks: ComplianceCheck[];
  unknownCount: number;
}

export const WEIGHTS: Record<CheckId, number> = {
  bitlocker: 25,
  antivirus: 25,
  updates: 20,
  tpm: 10,
  secureBoot: 10,
  disk: 10,
};

const half = (w: number) => Math.floor(w / 2);

function earn(weight: number, status: CheckStatus): number {
  if (status === "pass") return weight;
  if (status === "warn") return half(weight);
  return 0; // fail OR unknown
}

function bitlockerCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.bitlocker;
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (p.bitlocker === "on") (status = "pass"), (detail = "Encrypted");
  else if (p.bitlocker === "off") (status = "fail"), (detail = "Not encrypted");
  return { id: "bitlocker", label: "BitLocker", status, weight: w, earned: earn(w, status), detail };
}

function antivirusCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.antivirus;
  const name = p.avProduct ?? "Antivirus";
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (p.defenderRealtime === false) {
    status = "fail";
    detail = `${name} real-time protection off`;
  } else if (p.defenderRealtime === true) {
    const age = p.defenderSigAgeDays;
    if (age == null) (status = "pass"), (detail = `${name} running`);
    else if (age <= 7) (status = "pass"), (detail = `${name}, signatures ${age}d old`);
    else if (age <= 30) (status = "warn"), (detail = `${name}, signatures ${age}d old`);
    else (status = "fail"), (detail = `${name}, signatures ${age}d old`);
  }
  return { id: "antivirus", label: "Antivirus", status, weight: w, earned: earn(w, status), detail };
}

function updatesCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.updates;
  const d = p.updatesLastDays;
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (d != null) {
    if (d <= 14) status = "pass";
    else if (d <= 30) status = "warn";
    else status = "fail";
    detail = `Last update ${d} day${d === 1 ? "" : "s"} ago`;
  }
  return { id: "updates", label: "Windows Update", status, weight: w, earned: earn(w, status), detail };
}

function tpmCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.tpm;
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (p.tpmReady === true) (status = "pass"), (detail = "Present & ready");
  else if (p.tpmReady === false) (status = "fail"), (detail = "Absent or not ready");
  return { id: "tpm", label: "TPM", status, weight: w, earned: earn(w, status), detail };
}

function secureBootCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.secureBoot;
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (p.secureBoot === "on") (status = "pass"), (detail = "Enabled");
  else if (p.secureBoot === "off") (status = "fail"), (detail = "Disabled");
  return { id: "secureBoot", label: "Secure Boot", status, weight: w, earned: earn(w, status), detail };
}

function diskCheck(p: CompliancePosture): ComplianceCheck {
  const w = WEIGHTS.disk;
  const pct = p.systemDrivePctUsed;
  let status: CheckStatus = "unknown";
  let detail = "Unknown — couldn't read";
  if (pct != null) {
    if (pct < 85) status = "pass";
    else if (pct <= 95) status = "warn";
    else status = "fail";
    detail = `System drive ${Math.round(pct)}% full`;
  }
  return { id: "disk", label: "Disk space", status, weight: w, earned: earn(w, status), detail };
}

/** Derive the full score + per-check verdicts from a stored posture row. */
export function scoreCompliance(p: CompliancePosture): ComplianceScore {
  const checks = [
    bitlockerCheck(p),
    antivirusCheck(p),
    updatesCheck(p),
    tpmCheck(p),
    secureBootCheck(p),
    diskCheck(p),
  ];
  const unknownCount = checks.filter((c) => c.status === "unknown").length;
  const assessed = unknownCount < checks.length; // at least one known signal
  const score = assessed
    ? Math.round(checks.reduce((sum, c) => sum + c.earned, 0))
    : null;
  return { assessed, score, checks, unknownCount };
}
