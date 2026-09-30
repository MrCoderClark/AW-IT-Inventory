"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

/**
 * Detail-page tab strip (spec 17.01, AC-1.5). A horizontal row of tabs with a
 * blue active underline that swaps panels without navigation. Built on Base UI
 * Tabs, so it is keyboard operable (arrow keys, Home/End) and carries the right
 * roles/ARIA out of the box. Consumed by the printer and category detail pages
 * (children 03, 04).
 *
 * Usage:
 *   <Tabs defaultValue="overview">
 *     <TabsList>
 *       <TabsTab value="overview">Overview</TabsTab>
 *       <TabsTab value="network">Network</TabsTab>
 *     </TabsList>
 *     <TabsPanel value="overview">…</TabsPanel>
 *     <TabsPanel value="network">…</TabsPanel>
 *   </Tabs>
 */

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative flex items-stretch gap-6 border-b border-border",
        className,
      )}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className={cn(
          "absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-all duration-200 ease-out",
          "w-(--active-tab-width) translate-x-(--active-tab-left)",
        )}
        renderBeforeHydration
      />
    </TabsPrimitive.List>
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "-mb-px cursor-default border-b-2 border-transparent pb-3 pt-1 text-sm font-medium text-muted-foreground transition-colors outline-none select-none",
        "hover:text-foreground",
        "data-[selected]:text-foreground",
        "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-lg",
        className,
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTab, TabsPanel }
