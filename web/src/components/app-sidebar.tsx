"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Settings2 } from "lucide-react";

import {
  NAV_PRIMARY,
  NAV_ASSETS,
  NAV_MANAGE,
  ADMIN_ONLY_NAV,
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
        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-sidebar-foreground",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full bg-sidebar-primary"
        />
      )}
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

/** The ids of every ancestor of `targetId` (not including it), or null when the
   target isn't in the tree. Used to auto-open the active location's branch. */
function findAncestorIds(
  nodes: LocationNode[],
  targetId: string,
  trail: string[] = [],
): string[] | null {
  for (const n of nodes) {
    if (n.id === targetId) return trail;
    const found = findAncestorIds(n.children, targetId, [...trail, n.id]);
    if (found) return found;
  }
  return null;
}

/** A single node in the sidebar location tree: a link to its device page, plus
   an expand toggle for its children. Hierarchy reads from indentation and subtle
   guide rails (not a pin on every row), so deep trees stay clean. */
function LocationNavNode({
  node,
  pathname,
  expanded,
  onToggle,
  onOpen,
  isRoot = false,
}: {
  node: LocationNode;
  pathname: string;
  expanded: Set<string>;
  /** Toggle a branch open/closed (the chevron, and clicking a nested row). */
  onToggle: (id: string) => void;
  /** Ensure a branch is open (clicking the root row, which never collapses). */
  onOpen: (id: string) => void;
  /** Top-level location: its row opens but never toggles closed on click. */
  isRoot?: boolean;
}) {
  const hasChildren = node.children.length > 0;
  // Collapsed by default: a branch opens only when its id is in `expanded`.
  const isOpen = expanded.has(node.id);
  const href = `/locations/${node.id}`;
  const active = pathname === href;

  return (
    <div>
      <div
        className={cn(
          "group/loc flex items-center gap-0.5 rounded-md pr-1.5 text-sm transition-colors",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-sidebar-foreground",
        )}
      >
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground/60 hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-200",
                isOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          // Leaf: a small bullet, aligned where the chevron would sit.
          <span aria-hidden className="grid size-6 shrink-0 place-items-center">
            <span className="size-1 rounded-full bg-current opacity-40" />
          </span>
        )}
        <Link
          href={href}
          aria-current={active ? "page" : undefined}
          // Clicking a parent row works like its arrow, so the whole row is an
          // easy target: a nested parent toggles open/closed, while the root only
          // opens (collapse the root with its chevron). Leaves just navigate.
          onClick={
            !hasChildren
              ? undefined
              : isRoot
                ? () => onOpen(node.id)
                : () => onToggle(node.id)
          }
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5"
        >
          <span className="truncate">{node.name}</span>
          {node.deviceCount > 0 && (
            <span
              className={cn(
                "ml-auto shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums",
                active
                  ? "bg-sidebar-accent-foreground/15 text-sidebar-accent-foreground"
                  : "bg-muted text-muted-foreground/80",
              )}
            >
              {node.deviceCount}
            </span>
          )}
        </Link>
      </div>
      {hasChildren && isOpen && (
        // The guide rail: children indent from a faint vertical line, so nesting
        // is legible without a wall of padding.
        <div className="ml-3 border-l border-sidebar-border pl-1">
          {node.children.map((child) => (
            <LocationNavNode
              key={child.id}
              node={child}
              pathname={pathname}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The Locations section: a plain section label (like ASSETS / MANAGE) over the
   per-node collapsible tree, with a hover gear to the management page. */
function LocationsNav({
  tree,
  pathname,
}: {
  tree: LocationNode[];
  pathname: string;
}) {
  // Collapsed by default: only the ids in here are expanded.
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // Keep the branch of the location you're viewing open, so navigating into a
  // nested floor doesn't leave the tree collapsed around you. Additive: never
  // closes branches the user opened by hand.
  const activeId = pathname.startsWith("/locations/")
    ? pathname.slice("/locations/".length)
    : null;
  React.useEffect(() => {
    if (!activeId) return;
    const trail = findAncestorIds(tree, activeId);
    // Open only the active location's ancestors, not the node itself, so that
    // clicking a nested parent can toggle it closed without this reopening it.
    if (trail && trail.length > 0) {
      setExpanded((prev) => new Set([...prev, ...trail]));
    }
  }, [activeId, tree]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Ensure a branch is open (row click); never closes, so drilling in is easy.
  const openNode = (id: string) =>
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  return (
    <div className="px-3">
      {/* Section label, styled exactly like ASSETS / MANAGE so the tree reads as
         attached. The Manage-locations gear appears on hover (or when active). */}
      <div className="group/lochdr flex items-center justify-between px-3 pb-2 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Locations
        </p>
        <Link
          href="/locations"
          title="Manage locations"
          aria-label="Manage locations"
          className={cn(
            "grid size-5 place-items-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/lochdr:opacity-100",
            pathname === "/locations" && "text-sidebar-accent-foreground opacity-100",
          )}
        >
          <Settings2 className="size-3.5" />
        </Link>
      </div>
      {tree.length > 0 ? (
        <div className="grid gap-0.5">
          {tree.map((node) => (
            <LocationNavNode
              key={node.id}
              node={node}
              pathname={pathname}
              expanded={expanded}
              onToggle={toggle}
              onOpen={openNode}
              isRoot
            />
          ))}
        </div>
      ) : (
        <p className="px-3 py-1 text-xs text-muted-foreground/70">
          No locations yet.
        </p>
      )}
    </div>
  );
}

export function AppSidebar({ locations = [] }: { locations?: LocationNode[] }) {
  const pathname = usePathname();
  const canAdmin = useHasPermission("user:admin");
  const manageItems = canAdmin
    ? NAV_MANAGE
    : NAV_MANAGE.filter((item) => !ADMIN_ONLY_NAV.has(item.href));
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
    </aside>
  );
}
