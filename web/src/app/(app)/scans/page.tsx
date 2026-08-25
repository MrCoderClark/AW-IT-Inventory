import { ScanLine } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Scans & Discovery"
      description="Collector run history and the discovered-devices inbox for unmatched machines."
      icon={ScanLine}
    />
  );
}
