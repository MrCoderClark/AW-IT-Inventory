import Link from "next/link";
import {
  AppWindow,
  Gauge,
  LayoutDashboard,
  Lock,
  Radar,
  Shield,
  Ticket,
  TriangleAlert,
  UserCog,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DiscoveryToggles } from "@/components/discovery-toggles";
import { DashboardWidgetToggles } from "@/components/dashboard-widgets";
import { PagePlaceholder } from "@/components/page-placeholder";
import { SendCounterReport } from "@/components/send-counter-report";
import { TicketAutoCreateToggles } from "@/components/ticket-auto-create-toggles";
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
import { listTicketAutoCreateTypes } from "@/db/tickets";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Read fresh: the switches are shared and an admin may have just flipped one.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // The Admin page is admin-only: viewing requires user:admin, matching its nav
  // and ⌘K visibility (RBAC audit). Editing the settings still needs scan:write.
  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Admin"
        description="You don't have permission to view admin settings. Ask an admin for the admin role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "scan:write");
  const canManageTickets = hasPermission(user, "user:admin");
  const [settings, widgetSettings, trackedSoftware, ticketAutoCreateTypes] =
    await Promise.all([
      getDiscoverySettings(),
      getDashboardWidgetSettings(),
      canWrite ? getTrackedSoftware() : Promise.resolve([]),
      listTicketAutoCreateTypes(),
    ]);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage users, roles, alert rules and what the collector discovers.
        </p>
      </div>

      {/* Users & roles (aw-auth-backed). Visible to scan:read admins; the
          linked pages re-gate on user:admin and show a lock otherwise. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserCog className="size-5 text-muted-foreground" />
            <CardTitle>Users &amp; roles</CardTitle>
          </div>
          <CardDescription>
            Create accounts, assign roles, reset passwords and deactivate users.
            Requires the user:admin role.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link href="/admin/users" />}>
            <UserCog className="size-4" /> Manage users
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/admin/roles" />}
          >
            <Shield className="size-4" /> View roles
          </Button>
        </CardContent>
      </Card>

      {/* Metric-threshold rules (spec 30, AC-1). The page re-gates on
          user:admin; asset:read viewers never see this card or the nav item. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-muted-foreground" />
            <CardTitle>Alert rules</CardTitle>
          </div>
          <CardDescription>
            Thresholds on CPU, memory, disk and uptime. When a condition holds
            for enough samples, admins get a notification.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            nativeButton={false}
            render={<Link href="/admin/alert-rules" />}
          >
            <TriangleAlert className="size-4" /> Manage alert rules
          </Button>
        </CardContent>
      </Card>

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
            <Ticket className="size-5 text-muted-foreground" />
            <CardTitle>Ticket auto-create</CardTitle>
          </div>
          <CardDescription>
            Choose which notification types automatically open an IT ticket. When
            a type is off or not listed, no ticket is created until an admin
            creates one from the notification.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TicketAutoCreateToggles
            types={ticketAutoCreateTypes}
            canWrite={canManageTickets}
          />
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
