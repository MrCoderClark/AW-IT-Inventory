import { AppWindow, Gauge, LayoutDashboard, Lock, Radar } from "lucide-react";

import { DiscoveryToggles } from "@/components/discovery-toggles";
import { DashboardWidgetToggles } from "@/components/dashboard-widgets";
import { PagePlaceholder } from "@/components/page-placeholder";
import { SendCounterReport } from "@/components/send-counter-report";
import { TrackedSoftwareCard } from "@/components/tracked-software-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDashboardWidgetSettings } from "@/db/dashboard";
import { getDiscoverySettings } from "@/db/discovery";
import { getTrackedSoftware } from "@/db/software";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Read fresh: the switches are shared and an admin may have just flipped one.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // Viewing discovery settings needs scan:read; editing needs scan:write (AC-7).
  if (!hasPermission(user, "scan:read")) {
    return (
      <PagePlaceholder
        title="Admin"
        description="You don't have permission to view admin settings. Ask an admin for the scan:read role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "scan:write");
  const [settings, widgetSettings, trackedSoftware] = await Promise.all([
    getDiscoverySettings(),
    getDashboardWidgetSettings(),
    canWrite ? getTrackedSoftware() : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Users, roles and service accounts are powered by the aw-auth service in
          a later phase.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Radar className="size-5 text-muted-foreground" />
            <CardTitle>Discovery</CardTitle>
          </div>
          <CardDescription>
            Choose what the collector automatically discovers on each sweep. A
            manual scan you start always runs, whatever these switches say.
            {!canWrite && " You need the scan:write role to change these."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DiscoveryToggles settings={settings} canWrite={canWrite} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <LayoutDashboard className="size-5 text-muted-foreground" />
            <CardTitle>Dashboard widgets</CardTitle>
          </div>
          <CardDescription>
            Turn optional dashboard widgets on or off for everyone.
            {!canWrite && " You need the scan:write role to change these."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DashboardWidgetToggles settings={widgetSettings} canWrite={canWrite} />
        </CardContent>
      </Card>

      {/* Printer page-counter report (spec 14, AC-5). The button is shown only to
          scan:write admins; the server action re-checks the permission too. */}
      {canWrite && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Gauge className="size-5 text-muted-foreground" />
              <CardTitle>Printer page counters</CardTitle>
            </div>
            <CardDescription>
              The admins get a daily email of each printer&apos;s total pages and
              the day&apos;s change (default 08:05). Send it now to get a fresh
              report on demand.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SendCounterReport />
          </CardContent>
        </Card>
      )}

      {/* Software watchlist (spec 15, AC-1). Management is scan:write only (AC-7);
          viewing tracked software lives on the /software page, open to any
          asset:read user. */}
      {canWrite && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AppWindow className="size-5 text-muted-foreground" />
              <CardTitle>Tracked software</CardTitle>
            </div>
            <CardDescription>
              Choose the software titles to watch across the fleet. A Windows scan
              records each title it finds on a managed computer; the Software page
              shows where each is installed and on which versions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrackedSoftwareCard titles={trackedSoftware} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
