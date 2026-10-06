import { Lock, Shield } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { listRoles } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Roles"
        description="You don't have permission to view roles. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }

  const { access } = await readTokens();
  const rolesRes = await listRoles(access ?? "");

  if (!rolesRes.ok) {
    return (
      <PagePlaceholder title="Roles" description={rolesRes.error} icon={Shield} />
    );
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <HeroHeader
        title="Roles"
        subtitle="The access each role grants. Assign roles to users on the Users page."
        icon={<Shield className="size-6" />}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {rolesRes.data.map((role) => (
          <Card key={role.name}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>{role.name}</CardTitle>
                {role.is_system && <Badge variant="outline">System</Badge>}
              </div>
              {role.description && (
                <CardDescription>{role.description}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              {role.permissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No permissions.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {role.permissions.map((p) => (
                    <Badge key={p} variant="secondary" className="font-mono">
                      {p}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
