import { Smartphone } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Phones"
      description="Mobile devices with assignment, model and warranty details."
      icon={Smartphone}
    />
  );
}
