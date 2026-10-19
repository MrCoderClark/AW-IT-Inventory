import { Lock, TerminalSquare } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { ScriptLibrary } from "@/components/script-library";
import { listScripts } from "@/db/scripts";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "software:deploy")) {
    return (
      <PagePlaceholder
        title="Scripts"
        description="You don't have permission to manage scripts. Ask an owner for the software:deploy role."
        icon={Lock}
      />
    );
  }

  const scripts = await listScripts();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <HeroHeader
        title="Scripts"
        subtitle="Saved PowerShell to run on one computer at a time."
        icon={<TerminalSquare />}
      />
      <ScriptLibrary initial={scripts} />
    </div>
  );
}
