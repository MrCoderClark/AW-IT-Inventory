import { Cpu } from "lucide-react";
import { PagePlaceholder } from "@/components/page-placeholder";

export default function Page() {
  return (
    <PagePlaceholder
      title="Computers"
      description="A filtered view of every computer, with per-machine hardware and health from the collector. Building this next."
      icon={Cpu}
    />
  );
}
