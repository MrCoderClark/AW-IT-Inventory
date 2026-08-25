"use client";

import { useRouter } from "next/navigation";
import { Bell, Mail, Menu, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { OPEN_COMMAND_EVENT } from "@/components/command-palette";
import { useUser } from "@/components/user-provider";
import { NAV_PRIMARY, NAV_ASSETS, NAV_MANAGE } from "@/lib/data";
import Link from "next/link";

function openCommand() {
  window.dispatchEvent(new Event(OPEN_COMMAND_EVENT));
}

function initialsOf(name: string, email: string): string {
  const base = name.trim() || email;
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

export function TopBar() {
  const router = useRouter();
  const user = useUser();
  const displayName = user.full_name.trim() || user.email;
  const roleLabel = user.roles[0] ?? (user.is_staff ? "Staff" : "Member");
  const initials = initialsOf(user.full_name, user.email);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur md:px-6">
      {/* Mobile nav */}
      <Sheet>
        <SheetTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              className="md:hidden"
              aria-label="Menu"
            />
          }
        >
          <Menu className="size-[18px]" />
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader>
            <SheetTitle>OPUS — IT Inventory</SheetTitle>
          </SheetHeader>
          <nav className="grid gap-0.5 px-3 pb-4">
            {[...NAV_PRIMARY, ...NAV_ASSETS, ...NAV_MANAGE].map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Icon className="size-[18px]" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>

      {/* Global search → opens command palette */}
      <button
        type="button"
        onClick={openCommand}
        className="flex h-10 w-full max-w-md items-center gap-2 rounded-xl border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-ring/50"
      >
        <Search className="size-4" />
        <span>Global search</span>
        <kbd className="ml-auto hidden rounded border px-1.5 py-0.5 font-mono text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <Button variant="outline" size="icon" aria-label="Mail">
          <Mail className="size-[18px]" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Notifications" className="relative">
          <Bell className="size-[18px]" />
          <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            1
          </span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="flex items-center gap-2.5 rounded-xl p-1 pr-2 hover:bg-accent" />
            }
          >
            <Avatar className="size-9">
              <AvatarFallback className="bg-primary font-bold text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-40 text-left leading-tight sm:block">
              <span className="block truncate text-sm font-semibold">
                {displayName}
              </span>
              <span className="block text-xs text-muted-foreground">
                {roleLabel}
              </span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate text-sm font-semibold">
                  {displayName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>Profile</DropdownMenuItem>
              <DropdownMenuItem>Preferences</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={signOut}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
