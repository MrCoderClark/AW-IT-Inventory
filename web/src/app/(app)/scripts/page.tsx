import { Lock, TerminalSquare } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { ScriptLibrary } from "@/components/script-library";
import { ScriptSchedulesPanel } from "@/components/script-schedules-panel";
import { getLocationOptions } from "@/db/queries";
import { listScriptSchedules } from "@/db/script-schedules";
import { listComputerPickerOptions } from "@/db/script-targets";
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

  const [scripts, schedules, computers, locations] = await Promise.all([
    listScripts(),
    listScriptSchedules(),
    listComputerPickerOptions(),
    getLocationOptions(),
  ]);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-8">
      <HeroHeader
        title="Scripts"
        subtitle="Saved PowerShell — run on one computer, fan out to many, or schedule."
        icon={<TerminalSquare />}
      />
      <ScriptLibrary
        initial={scripts}
        computers={computers}
        locations={locations}
      />
      <ScriptSchedulesPanel
        schedules={schedules}
        scripts={scripts}
        computers={computers}
        locations={locations}
      />
    </div>
  );
}
