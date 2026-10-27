import { NextResponse } from "next/server";

import { getSoftwarePackage } from "@/db/software-packages";
import type { SoftwareStep } from "@/db/schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { isAiConfigured, loadAiConfig } from "@/lib/ai/config";
import { parseAssistResult } from "@/lib/ai/parse";
import { getAiProvider } from "@/lib/ai/providers";
import {
  buildExportPs1,
  type ExportPs1File,
} from "@/lib/software-export-script";
import {
  exportExpiryUnix,
  mintExportFileSig,
} from "@/lib/software-export-sign";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

type PackageFileRef = {
  fileName: string;
  storageKey: string;
  sha256?: string;
};

function publicBaseUrl(request: Request): string {
  const fromEnv = process.env.WEB_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return new URL(request.url).origin;
}

function filesFromSteps(steps: SoftwareStep[]): PackageFileRef[] {
  const out: PackageFileRef[] = [];
  for (const s of steps) {
    if (s.kind !== "install") continue;
    out.push({
      fileName: s.fileName,
      storageKey: s.storageKey,
      sha256: s.sha256,
    });
    for (const c of s.companions ?? []) {
      out.push({
        fileName: c.fileName,
        storageKey: c.storageKey,
        sha256: c.sha256,
      });
    }
  }
  return out;
}

function mintFileUrl(
  baseUrl: string,
  packageId: string,
  file: PackageFileRef,
  expUnix: number,
): ExportPs1File {
  const sig = mintExportFileSig(
    packageId,
    file.fileName,
    file.storageKey,
    expUnix,
  );
  const url = new URL(
    `/api/software/packages/${packageId}/export-file`,
    baseUrl,
  );
  url.searchParams.set("fileName", file.fileName);
  url.searchParams.set("storageKey", file.storageKey);
  url.searchParams.set("exp", String(expUnix));
  url.searchParams.set("sig", sig);
  return {
    fileName: file.fileName,
    url: url.toString(),
    sha256: file.sha256,
  };
}

function assistResultToComments(result: ReturnType<typeof parseAssistResult>): string {
  const lines: string[] = [];
  for (const o of result.observed) lines.push(`Observed: ${o}`);
  for (const h of result.hypotheses) lines.push(`Note: ${h}`);
  for (const r of result.recommendations) lines.push(`Tip: ${r}`);
  return lines.join("\n");
}

async function optionalExportAiComments(pkg: {
  name: string;
  version: string;
  steps: SoftwareStep[];
}): Promise<string | undefined> {
  if (!isAiConfigured()) return undefined;
  const stepSummary = pkg.steps.map((s, i) => {
    if (s.kind === "script") {
      return `${i + 1}. Script: ${s.name}`;
    }
    return `${i + 1}. Install (${s.installerType}): ${s.name} — ${s.fileName}`;
  });
  try {
    const provider = getAiProvider(loadAiConfig());
    const raw = await provider.complete({
      system: `You are an IT operations assistant for H2Tecs break-glass software export.
Add brief preflight warnings as comments only. Never rewrite install commands or scripts.`,
      user: `Package: ${pkg.name} v${pkg.version}\nSteps:\n${stepSummary.join("\n")}\n\nRespond with JSON: observed, hypotheses, recommendations (string arrays). Warnings only.`,
      jsonSchemaHint: `{"observed": string[], "hypotheses": string[], "recommendations": string[]}`,
    });
    const text = assistResultToComments(parseAssistResult(raw)).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function attachmentFilename(name: string, version: string): string {
  const base = `${name}-${version}`
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return `${base || "package"}-install.ps1`;
}

/**
 * Break-glass export (spec 23 polish): mint short-lived signed file URLs and return
 * a standalone `.ps1` install script. Gated on `software:deploy`.
 */
export async function GET(request: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "software:deploy"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const pkg = await getSoftwarePackage(id);
  if (!pkg)
    return NextResponse.json({ error: "no such package" }, { status: 404 });

  const url = new URL(request.url);
  const wantAi = url.searchParams.get("aiComments") === "1";
  let aiComments: string | undefined;
  if (wantAi) {
    aiComments = await optionalExportAiComments(pkg);
  }

  const baseUrl = publicBaseUrl(request);
  let body: string;
  try {
    const expUnix = exportExpiryUnix();
    const files = filesFromSteps(pkg.steps).map((f) =>
      mintFileUrl(baseUrl, id, f, expUnix),
    );
    body = buildExportPs1({
      packageName: pkg.name,
      version: pkg.version,
      baseUrl,
      steps: pkg.steps,
      files,
      aiComments,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "export failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const filename = attachmentFilename(pkg.name, pkg.version);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
