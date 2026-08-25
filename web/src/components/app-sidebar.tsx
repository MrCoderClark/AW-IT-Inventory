"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_PRIMARY, NAV_ASSETS, NAV_MANAGE, type NavItem } from "@/lib/data";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useHasPermission } from "@/components/user-provider";

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      {item.label}
    </Link>
  );
}

function Section({ label, items, pathname }: { label?: string; items: NavItem[]; pathname: string }) {
  return (
    <div className="px-3">
      {label && (
        <p className="px-3 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </p>
      )}
      <div className="grid gap-0.5">
        {items.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={pathname === item.href}
          />
        ))}
      </div>
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const canAdmin = useHasPermission("user:admin");
  const manageItems = canAdmin
    ? NAV_MANAGE
    : NAV_MANAGE.filter((item) => item.href !== "/admin");
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      {/* Wordmark */}
      <div className="flex items-center gap-3 px-5 py-5">
        <span
          aria-hidden
          className="grid size-9 place-items-center rounded-full"
          style={{
            background:
              "conic-gradient(from 210deg, var(--chart-1), var(--chart-2), var(--chart-5), var(--chart-1))",
          }}
        >
          <span className="size-3 rounded-full bg-sidebar" />
        </span>
        <span className="leading-none">
          <span className="block text-xl font-extrabold tracking-tight">OPUS</span>
          <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
            IT Inventory
          </span>
        </span>
      </div>

      <ScrollArea className="flex-1">
        <nav className="pb-4">
          <Section items={NAV_PRIMARY} pathname={pathname} />
          <Section label="Assets" items={NAV_ASSETS} pathname={pathname} />
          <Section label="Manage" items={manageItems} pathname={pathname} />
        </nav>
      </ScrollArea>

      {/* Collector status */}
      <div className="flex items-center gap-3 border-t px-5 py-4">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-deployed opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-status-deployed" />
        </span>
        <div className="leading-tight">
          <p className="text-xs font-semibold">Collector online</p>
          <p className="text-[11px] text-muted-foreground">
            Last scan 02:00 · 96% reached
          </p>
        </div>
      </div>
    </aside>
  );
}
