import { Printer } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Printers"
      description="Printers and MFPs with SNMP-collected toner levels, page counts and status."
      icon={Printer}
    />
  );
}
