import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import {
  SoftwareLibrary,
  type SoftwarePackageItem,
} from "@/components/software-library";
import { listSoftwarePackages } from "@/db/software-packages";
import { hasPermission, requireUser } from "@/lib/auth/session";
import { isStorageConfigured } from "@/lib/storage";

// The library changes on upload/delete; always read fresh.
export const dynamic = "force-dynamic";

/**
 * The Software Library (spec 23): uploaded MSI/EXE installers an admin can deploy
 * to computers. Managing it needs `software:deploy` (Owner + Admin). This is the
 * catalog surface; deploying a package happens from a Computer's detail page.
 */
export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "software:deploy")) {
    return (
      <PagePlaceholder
        title="Software Library"
        description="You don't have permission to manage software deployment. Ask an owner for the software:deploy role."
        icon={Lock}
      />
    );
  }

  const rows = await listSoftwarePackages();
  const items: SoftwarePackageItem[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    publisher: p.publisher,
    uploadedBy: p.uploadedBy,
    createdAt: p.createdAt.toISOString(),
    steps: p.steps,
  }));

  return (
    <div className="mx-auto w-full max-w-[1280px]">
      <SoftwareLibrary
        initialItems={items}
        storageConfigured={isStorageConfigured()}
      />
    </div>
  );
}
