import { Lock, Radar } from "lucide-react";

import { DiscoveryToggles } from "@/components/discovery-toggles";
import { PagePlaceholder } from "@/components/page-placeholder";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDiscoverySettings } from "@/db/discovery";
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
  const settings = await getDiscoverySettings();

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
    </div>
  );
}
