import { Network } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Network"
      description="Switches, access points and network gear discovered on the 70/72 subnets."
      icon={Network}
    />
  );
}
