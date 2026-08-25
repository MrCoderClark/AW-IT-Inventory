import { Settings } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Admin"
      description="Users, roles and service accounts — powered by the aw-auth service in a later phase."
      icon={Settings}
    />
  );
}
