import { LoginForm } from "@/components/login-form";

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const nextParam = sp.next;
  const next = typeof nextParam === "string" ? nextParam : "/dashboard";

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="mb-8 flex items-center justify-center gap-3">
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-full"
            style={{
              background:
                "conic-gradient(from 210deg, var(--chart-1), var(--chart-2), var(--chart-5), var(--chart-1))",
            }}
          >
            <span className="size-3.5 rounded-full bg-background" />
          </span>
          <span className="leading-none">
            <span className="block text-2xl font-extrabold tracking-tight">
              OPUS
            </span>
            <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              IT Inventory
            </span>
          </span>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">
            Access the OPUS asset console.
          </p>
          <LoginForm next={next} />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Protected system · authorized personnel only
        </p>
      </div>
    </div>
  );
}
