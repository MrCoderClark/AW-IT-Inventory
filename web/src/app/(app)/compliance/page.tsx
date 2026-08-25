import { ShieldCheck } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Compliance"
      description="BitLocker, antivirus, patch level and local-admin exceptions from collector scans."
      icon={ShieldCheck}
    />
  );
}
