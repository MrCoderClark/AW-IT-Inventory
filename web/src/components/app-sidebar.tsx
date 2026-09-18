"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, MapPin, Settings2 } from "lucide-react";

import {
  NAV_PRIMARY,
  NAV_ASSETS,
  NAV_MANAGE,
  type LocationNode,
  type NavItem,
} from "@/lib/data";
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

/** A single node in the sidebar location tree: a link to its device page, plus
   an expand toggle for its children. */
function LocationNavNode({
  node,
  depth,
  pathname,
  collapsed,
  onToggle,
}: {
  node: LocationNode;
  depth: number;
  pathname: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = !collapsed.has(node.id);
  const href = `/locations/${node.id}`;
  const active = pathname === href;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 rounded-lg pr-2 text-sm transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            className="grid size-5 shrink-0 place-items-center rounded hover:text-foreground"
          >
            {isOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <Link
          href={href}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 font-medium"
        >
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
          {node.deviceCount > 0 && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              {node.deviceCount}
            </span>
          )}
        </Link>
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children.map((child) => (
            <LocationNavNode
              key={child.id}
              node={child}
              depth={depth + 1}
              pathname={pathname}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The collapsible Locations section: navigate the tree to filter devices by a
   location's subtree, with a gear link to the management page. */
function LocationsNav({
  tree,
  pathname,
}: {
  tree: LocationNode[];
  pathname: string;
}) {
  const [open, setOpen] = React.useState(true);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="px-3">
      <div className="flex items-center justify-between pb-2 pt-4 pl-3 pr-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          Locations
        </button>
        <Link
          href="/locations"
          title="Manage locations"
          aria-label="Manage locations"
          className={cn(
            "grid size-6 place-items-center rounded-md text-muted-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            pathname === "/locations" && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Settings2 className="size-4" />
        </Link>
      </div>
      {open &&
        (tree.length > 0 ? (
          <div className="grid gap-0.5">
            {tree.map((node) => (
              <LocationNavNode
                key={node.id}
                node={node}
                depth={0}
                pathname={pathname}
                collapsed={collapsed}
                onToggle={toggle}
              />
            ))}
          </div>
        ) : (
          <p className="px-3 py-1 text-xs text-muted-foreground/70">
            No locations yet.
          </p>
        ))}
    </div>
  );
}

export function AppSidebar({ locations = [] }: { locations?: LocationNode[] }) {
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
          <LocationsNav tree={locations} pathname={pathname} />
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
