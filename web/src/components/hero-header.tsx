import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Reusable page hero header (spec 17.01, AC-1.4). Renders a page
 * title/subtitle/actions, with an optional icon tile and an optional
 * photographic background image. When an image is set, a gradient scrim runs
 * from the card color on the text side to transparent over the photo, so the
 * title/subtitle stay AA legible in both light and dark. Used by the printers
 * list now (child 03) and available to other list pages later.
 */
export function HeroHeader({
  title,
  subtitle,
  icon,
  actions,
  backgroundImage,
  className,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Optional icon shown in a tinted blue tile left of the title. */
  icon?: React.ReactNode
  /** Right-aligned actions (buttons, etc.). */
  actions?: React.ReactNode
  /** Optional decorative photo bled in on the right, under a gradient scrim. */
  backgroundImage?: string
  className?: string
}) {
  return (
    <section
      className={cn(
        "relative isolate overflow-hidden rounded-(--radius-card) bg-card ring-1 ring-foreground/10",
        className,
      )}
    >
      {backgroundImage && (
        <>
          <img
            src={backgroundImage}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 -z-10 h-full w-3/5 object-cover"
          />
          {/* Scrim: solid card color over the text, fading to reveal the photo. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(to right, var(--card) 0%, var(--card) 42%, color-mix(in oklch, var(--card), transparent 100%) 100%)",
            }}
          />
        </>
      )}
      <div className="flex flex-col gap-4 px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-4">
          {icon && (
            <span
              aria-hidden
              className="grid size-12 shrink-0 place-items-center rounded-(--radius-control) bg-accent-soft text-primary [&_svg]:size-6"
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </section>
  )
}
