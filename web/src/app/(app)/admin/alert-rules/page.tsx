import { Lock } from "lucide-react";

import { AlertRulesTable } from "@/components/alert-rules-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { listAlertRules } from "@/db/alert-rules";
import { listDeviceGroupOptions } from "@/db/device-groups";
import { listScripts } from "@/db/scripts";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Alert rules"
        description="You don't have permission to manage alert rules. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }

  const [rules, scriptRows, groups] = await Promise.all([
    listAlertRules(),
    listScripts(),
    listDeviceGroupOptions(),
  ]);
  const scripts = scriptRows.map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <AlertRulesTable rules={rules} scripts={scripts} groups={groups} />
    </div>
  );
}
