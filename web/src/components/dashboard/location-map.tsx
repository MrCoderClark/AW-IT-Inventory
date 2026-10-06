"use client";

import * as React from "react";
import "leaflet/dist/leaflet.css";

import type { LocationMapPoint } from "@/lib/data";

/**
 * The dashboard "Asset Locations" map (spec: dashboard map). Plots a pin per
 * geocoded location (its subtree device count) on a free OpenStreetMap base layer
 * via Leaflet (both FOSS, no API key). Client-only: Leaflet touches `window`, so
 * it is imported lazily inside the effect and the map is built after mount. Falls
 * back to the list card when no location has coordinates (handled by the caller).
 */
export function LocationMap({ points }: { points: LocationMapPoint[] }) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any;

    (async () => {
      // Robust against CJS/ESM interop: Leaflet ships `export =`, so the namespace
      // is sometimes the module, sometimes its `.default`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("leaflet");
      const L = mod.default ?? mod;
      if (cancelled || !containerRef.current) return;

      map = L.map(containerRef.current, {
        scrollWheelZoom: false,
        attributionControl: true,
        zoomControl: true,
      });

      // Clean, minimal gray basemap matching the mock. Esri's "World Gray Canvas"
      // (light + dark) is genuinely free with no API key (attribution only) — unlike
      // CARTO/Stadia, which now require a key. Note the ArcGIS {z}/{y}/{x} tile order
      // and no {s} subdomain.
      const dark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      const base = dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base";
      L.tileLayer(
        `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`,
        {
          maxZoom: 16,
          attribution:
            'Tiles &copy; <a href="https://www.esri.com">Esri</a>',
        },
      ).addTo(map);

      const markers = points.map((p) => {
        const icon = L.divIcon({
          className: "opus-pin",
          html: `<span class="pin"><b>${p.count}</b></span>`,
          iconSize: [30, 42],
          iconAnchor: [15, 42],
          popupAnchor: [0, -38],
        });
        const marker = L.marker([p.lat, p.lng], { icon, title: p.name });
        marker.bindPopup(popupHtml(p, undefined));
        // Reverse-geocode the coordinates to a street address on first open
        // (lazy + cached), then update the popup in place.
        marker.on("popupopen", async () => {
          const cached = addressCache.get(cacheKey(p.lat, p.lng));
          if (cached !== undefined) {
            marker.setPopupContent(popupHtml(p, cached));
            return;
          }
          marker.setPopupContent(popupHtml(p, null)); // "Looking up…"
          const addr = await reverseGeocode(p.lat, p.lng);
          marker.setPopupContent(popupHtml(p, addr));
        });
        return marker;
      });

      if (markers.length) {
        const group = L.featureGroup(markers).addTo(map);
        map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 14 });
      } else {
        map.setView([20, 0], 1);
      }
      // The container often sizes after the map builds; nudge Leaflet to re-measure.
      setTimeout(() => map && map.invalidateSize(), 0);
    })();

    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [points]);

  return (
    <>
      <style>{`
        /* Teardrop pin (rounded square rotated 45°, point at the bottom) with the
           device count held upright inside — the mock's marker look. */
        .opus-pin .pin {
          display: grid; place-items: center;
          width: 28px; height: 28px;
          transform: rotate(-45deg);
          border-radius: 50% 50% 50% 0;
          background: var(--primary);
          border: 2px solid #fff;
          box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
        }
        .opus-pin .pin b {
          transform: rotate(45deg);
          color: var(--primary-foreground);
          font: 700 10px/1 ui-sans-serif, system-ui, sans-serif;
          font-variant-numeric: tabular-nums;
        }
        .leaflet-container { background: var(--muted); font: inherit; }
        .leaflet-bar a,
        .leaflet-bar a:hover {
          background: var(--card); color: var(--foreground);
          border-color: var(--border);
        }
        .leaflet-bar { border: none; box-shadow: 0 1px 3px rgb(0 0 0 / 0.15); border-radius: 8px; overflow: hidden; }
        .leaflet-control-attribution {
          font-size: 10px; background: color-mix(in oklch, var(--card), transparent 15%) !important;
          color: var(--muted-foreground);
        }
        .leaflet-control-attribution a { color: var(--primary); }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip {
          background: var(--card); color: var(--foreground);
        }
      `}</style>
      <div
        ref={containerRef}
        className="h-72 w-full overflow-hidden rounded-lg"
        role="img"
        aria-label={`Map of ${points.length} location${points.length === 1 ? "" : "s"}`}
      />
    </>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Reverse-geocode cache, shared across popups and re-renders. undefined = not yet
// fetched; "" = looked up but no address found.
const addressCache = new Map<string, string>();
const cacheKey = (lat: number, lng: number) => `${lat},${lng}`;

/** Reverse-geocode lat/long → a street address via Nominatim (OpenStreetMap's
   geocoder: free, no API key). Light, click-driven use only; results are cached so
   each pin hits it at most once. Returns "" on any failure. */
async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = cacheKey(lat, lng);
  const hit = addressCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`,
      { headers: { Accept: "application/json" } },
    );
    const addr = res.ok
      ? (((await res.json()) as { display_name?: string }).display_name ?? "")
      : "";
    addressCache.set(key, addr);
    return addr;
  } catch {
    return "";
  }
}

/** Popup HTML. `address`: undefined = not fetched yet (no line), null = loading,
   string = the resolved address ("" shows "address unavailable"). */
function popupHtml(
  p: LocationMapPoint,
  address: string | null | undefined,
): string {
  const head = `<strong>${escapeHtml(p.name)}</strong><br>${p.count} device${p.count === 1 ? "" : "s"}`;
  let line = "";
  if (address === null) {
    line = `<br><em style="color:var(--muted-foreground)">Looking up address…</em>`;
  } else if (address === "") {
    line = `<br><span style="color:var(--muted-foreground)">Address unavailable</span>`;
  } else if (typeof address === "string") {
    line = `<br><span style="color:var(--muted-foreground)">${escapeHtml(address)}</span>`;
  }
  return head + line;
}
