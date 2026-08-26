"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  NAV_PRIMARY,
  NAV_ASSETS,
  NAV_MANAGE,
  TYPE_ICON,
  type Asset,
} from "@/lib/data";

export const OPEN_COMMAND_EVENT = "opus:open-command";

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_EVENT, onOpen);
    };
  }, []);

  // Load assets lazily the first time the palette opens.
  React.useEffect(() => {
    if (!open || assets.length) return;
    let active = true;
    fetch("/api/assets")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (active) setAssets(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, assets.length]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const allNav = [...NAV_PRIMARY, ...NAV_ASSETS, ...NAV_MANAGE];

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search assets, people, or jump to a page…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {allNav.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={`nav ${item.label}`}
                onSelect={() => go(item.href)}
              >
                <Icon />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Assets">
          {assets.slice(0, 8).map((a) => {
            const Icon = TYPE_ICON[a.type];
            return (
              <CommandItem
                key={a.id}
                value={`${a.id} ${a.name} ${a.serial} ${a.assignee?.name ?? ""}`}
                onSelect={() => go(`/dashboard?asset=${a.id}`)}
              >
                <Icon />
                <span className="font-medium">{a.name}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {a.id}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="toggle theme dark light"
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            Toggle theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
