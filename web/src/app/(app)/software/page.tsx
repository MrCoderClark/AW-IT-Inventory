import { AppWindow } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Software"
      description="Installed applications and versions across the fleet for license auditing."
      icon={AppWindow}
    />
  );
}
