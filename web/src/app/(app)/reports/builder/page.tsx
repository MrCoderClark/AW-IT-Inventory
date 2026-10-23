import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock, Wand2 } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { ReportBuilder } from "@/components/report-builder";
import { Button } from "@/components/ui/button";
import { getReport, listReportCategories } from "@/db/report-engine";
import { hasPermission, requireUser } from "@/lib/auth/session";
import { reportSourceNeedsAuditRead } from "@/lib/report-sources";

// The builder runs reports live from the fleet — never serve a stale snapshot.
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await requireUser();

  if (!hasPermission(user, "report:read")) {
    return (
      <PagePlaceholder
        title="Report builder"
        description="You don't have permission to run reports. Ask an admin for the report:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await searchParams;
  const canReadAudit = hasPermission(user, "audit:read");
  const [existing, categories] = await Promise.all([
    id ? getReport(id) : Promise.resolve(null),
    listReportCategories(),
  ]);
  if (id && !existing) notFound();
  if (existing && reportSourceNeedsAuditRead(existing.source) && !canReadAudit) {
    return (
      <PagePlaceholder
        title="Report builder"
        description="You don't have permission to view computer audit events. Ask an administrator for the audit:read role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "report:write");

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
      <HeroHeader
        title={existing ? `Edit: ${existing.name}` : "New custom report"}
        subtitle="Pick a data source, choose columns, filter, group and sort — with a live preview."
        icon={<Wand2 />}
        actions={
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/reports" />}
          >
            <ArrowLeft /> Back to reports
          </Button>
        }
      />

      <ReportBuilder
        canWrite={canWrite}
        canReadAudit={canReadAudit}
        categories={categories}
        initial={
          existing
            ? {
                id: existing.id,
                name: existing.name,
                description: existing.description,
                category: existing.category,
                source: existing.source,
                spec: existing.spec,
              }
            : undefined
        }
      />
    </div>
  );
}
