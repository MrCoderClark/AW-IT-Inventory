import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { CommandPalette } from "@/components/command-palette";
import { UserProvider } from "@/components/user-provider";
import { requireUser } from "@/lib/auth/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  return (
    <UserProvider user={user}>
      <div className="flex min-h-full flex-1">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="flex-1 overflow-x-hidden px-4 py-6 md:px-6 lg:px-8">
            {children}
          </main>
        </div>
        <CommandPalette />
      </div>
    </UserProvider>
  );
}
