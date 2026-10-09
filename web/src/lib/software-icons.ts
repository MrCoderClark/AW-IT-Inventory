/**
 * Bundled brand icons for tracked software titles (spec 22). OPUS runs on-prem, so
 * icons are static files under `public/software-icons/` — never fetched from an
 * external CDN at runtime. A title with no entry falls back to a generic glyph in
 * the UI, so this is purely cosmetic and always optional.
 *
 * To add an icon: drop a square PNG (≈64px) or SVG in `public/software-icons/`,
 * then add a `"<lowercased tracked-title name>": "<filename>"` entry below. Match
 * is by exact, case-insensitive tracked-title name (the admin-entered watchlist
 * label), so the key must equal that title lowercased.
 */
const ICONS: Record<string, string> = {
  "av defender": "av-defender.png",
};

/** The built-in bundled icon path for a title, or null when none is bundled. */
export function softwareIconSrc(title: string): string | null {
  const file = ICONS[title.trim().toLowerCase()];
  return file ? `/software-icons/${file}` : null;
}

/**
 * Resolve the icon URL to render for a tracked title, with precedence:
 *   1. an admin-uploaded custom icon (served from the icon route, cache-busted);
 *   2. the built-in bundled registry icon for the title's name;
 *   3. null — the UI shows a generic glyph.
 * Pure and client-safe so the server read layer and the client components agree.
 */
export function resolveSoftwareIconUrl(opts: {
  id: string;
  name: string;
  iconKey?: string | null;
  iconUpdatedAt?: string | null;
}): string | null {
  if (opts.iconKey) {
    const v = opts.iconUpdatedAt
      ? `?v=${encodeURIComponent(opts.iconUpdatedAt)}`
      : "";
    return `/api/software/${opts.id}/icon${v}`;
  }
  return softwareIconSrc(opts.name);
}
