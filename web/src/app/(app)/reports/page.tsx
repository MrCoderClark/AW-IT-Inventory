import { FileText } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Reports"
      description="Warranty expiry, asset aging, software/license and compliance reports."
      icon={FileText}
    />
  );
}
