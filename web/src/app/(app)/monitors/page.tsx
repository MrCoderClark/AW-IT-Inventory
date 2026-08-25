import { Monitor } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Monitors"
      description="All displays across the fleet, with assignment and warranty tracking."
      icon={Monitor}
    />
  );
}
