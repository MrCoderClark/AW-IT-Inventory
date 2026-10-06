"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setLocationCoordinates } from "@/app/(app)/locations/actions";

/**
 * Set or clear a location's map coordinates (spec: dashboard map). Lives on the
 * location detail page; gated on `location:write` at the page and re-checked in
 * the action. Once a location has coordinates it appears as a pin on the
 * dashboard map (its subtree's device count).
 */
export function LocationCoordinatesForm({
  locationId,
  latitude,
  longitude,
}: {
  locationId: string;
  latitude: number | null;
  longitude: number | null;
}) {
  const router = useRouter();
  const [lat, setLat] = React.useState(latitude?.toString() ?? "");
  const [lng, setLng] = React.useState(longitude?.toString() ?? "");
  const [isSaving, startSave] = React.useTransition();

  function save(clear = false) {
    startSave(async () => {
      const payload = clear
        ? { latitude: null, longitude: null }
        : { latitude: lat, longitude: lng };
      const res = await setLocationCoordinates(locationId, payload);
      if (res.ok) {
        toast.success(res.message);
        if (clear) {
          setLat("");
          setLng("");
        }
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const hasCoords = latitude != null && longitude != null;

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="mb-1 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-primary">
          <MapPin className="size-4" />
        </span>
        <h2 className="font-heading text-base font-semibold">Map coordinates</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Add latitude &amp; longitude to plot this location on the dashboard map.
        Look up a place on{" "}
        <a
          href="https://www.openstreetmap.org"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          OpenStreetMap
        </a>{" "}
        and copy the coordinates.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Latitude</span>
          <Input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="40.7128"
            inputMode="decimal"
            className="w-36 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Longitude</span>
          <Input
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            placeholder="-74.0060"
            inputMode="decimal"
            className="w-36 font-mono"
          />
        </label>
        <Button onClick={() => save(false)} disabled={isSaving}>
          {isSaving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
        {hasCoords && (
          <Button
            variant="outline"
            onClick={() => save(true)}
            disabled={isSaving}
          >
            Clear
          </Button>
        )}
      </div>
    </section>
  );
}
