"use client";

import * as React from "react";
import { useServerInsertedHTML } from "next/navigation";

/**
 * App ThemeProvider + useTheme (same roles as next-themes).
 *
 * We keep the `next-themes` dependency in package.json, but do **not** mount
 * its provider: it renders an inline <script> inside a client component, which
 * React 19 / Next 16 surfaces as a console error and can block the error overlay.
 * FOUC init uses useServerInsertedHTML instead (outside the client tree).
 * Switch back to `next-themes` when upstream fixes that.
 */

export type AppTheme = "light" | "dark";

type ThemeContextValue = {
  theme: AppTheme;
  setTheme: (theme: AppTheme | ((prev: AppTheme) => AppTheme)) => void;
  resolvedTheme: AppTheme;
  themes: AppTheme[];
};

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined,
);

const DEFAULT_STORAGE_KEY = "theme";

function buildInitScript(storageKey: string, defaultTheme: AppTheme): string {
  // Mirrors next-themes class + colorScheme init; system mode not used here.
  return `(function(){try{var k=${JSON.stringify(storageKey)};var d=${JSON.stringify(defaultTheme)};var t=localStorage.getItem(k)||d;if(t!=="dark"&&t!=="light")t=d;var e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t);e.style.colorScheme=t;}catch(e){}})();`;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  storageKey = DEFAULT_STORAGE_KEY,
  // Accepted for layout API compatibility with the old next-themes props.
  attribute: _attribute = "class",
  enableSystem: _enableSystem = false,
  disableTransitionOnChange: _disableTransitionOnChange = false,
  ..._rest
}: {
  children: React.ReactNode;
  defaultTheme?: AppTheme;
  storageKey?: string;
  attribute?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
  [key: string]: unknown;
}) {
  const [theme, setThemeState] = React.useState<AppTheme>(defaultTheme);

  useServerInsertedHTML(() => (
    <script
      dangerouslySetInnerHTML={{
        __html: buildInitScript(storageKey, defaultTheme),
      }}
    />
  ));

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "dark" || stored === "light") {
        setThemeState(stored);
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* ignore */
    }
  }, [theme, storageKey]);

  const setTheme = React.useCallback(
    (next: AppTheme | ((prev: AppTheme) => AppTheme)) => {
      setThemeState((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      resolvedTheme: theme,
      themes: ["light", "dark"],
    }),
    [theme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: "light",
      setTheme: () => {},
      resolvedTheme: "light",
      themes: ["light", "dark"],
    };
  }
  return ctx;
}
