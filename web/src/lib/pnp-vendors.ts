/**
 * PnP/EISA 3-letter vendor codes → display vendor name (spec 25). A curated subset
 * of the UEFI PnP ID registry covering common monitor makers; an unmapped code
 * falls back to the raw code, so a new vendor still shows something sensible.
 */
export const PNP_VENDORS: Record<string, string> = {
  DEL: "Dell",
  SAM: "Samsung",
  GSM: "LG",
  LGD: "LG Display",
  GSW: "LG",
  AUO: "AU Optronics",
  ACI: "Asus",
  AUS: "Asus",
  ACR: "Acer",
  AOC: "AOC",
  BNQ: "BenQ",
  HWP: "HP",
  HPN: "HP",
  HPQ: "HP",
  LEN: "Lenovo",
  NEC: "NEC",
  PHL: "Philips",
  VSC: "ViewSonic",
  ENC: "Eizo",
  EIZ: "Eizo",
  IVM: "Iiyama",
  MSI: "MSI",
  HSD: "Hannspree",
  HSP: "Hannspree",
  CMN: "Chi Mei",
  CMO: "Chi Mei",
  SNY: "Sony",
  APP: "Apple",
  GBT: "Gigabyte",
  SHP: "Sharp",
  TOS: "Toshiba",
  BOE: "BOE",
  CTX: "CTX",
  PLN: "Planar",
  HEC: "Huawei",
  HUA: "Huawei",
  PGS: "Princeton",
  RTK: "Realtek",
  DON: "Denon",
};

/** Map a PnP vendor code to a name; unknown codes return the upper-cased code. */
export function vendorName(code: string | null | undefined): string | null {
  if (!code) return null;
  const up = code.trim().toUpperCase();
  if (!up) return null;
  return PNP_VENDORS[up] ?? up;
}

/**
 * EDID vendor codes that make built-in / OEM panels (a laptop's internal screen,
 * an all-in-one's panel), not standalone monitors. Used to skip auto-adding such
 * a display as a Monitor asset — it still shows in the manual discovery list, so a
 * genuine Sharp/BOE desktop monitor can be added by hand. Standalone monitors
 * carry a *brand* code (DEL, SAM, GSM, HWP, …) instead.
 */
export const PANEL_MAKER_CODES = new Set([
  "AUO", // AU Optronics
  "BOE", // BOE
  "LGD", // LG Display (panels) — LG monitors report GSM
  "CMN", // Chi Mei / Innolux
  "CMO", // Chi Mei Optoelectronics
  "SDC", // Samsung Display (panels) — Samsung monitors report SAM
  "SHP", // Sharp
  "IVO", // InfoVision
]);

/**
 * True when a scanned display should be auto-added to inventory: it has a serial
 * (the dedup/match key) and its vendor is a **recognized monitor brand** — a code
 * in {@link PNP_VENDORS} that isn't a built-in-panel maker. By design this is
 * conservative: an unknown/unmapped vendor code is NOT auto-added (it still shows
 * in the manual Discovered-displays list, where it can be added by hand), so a
 * scan only creates assets for brands we know (Dell, LG, Samsung, HP, …).
 */
export function isExternalMonitor(
  code: string | null | undefined,
  serial: string | null | undefined,
): boolean {
  if (!serial || !serial.trim()) return false;
  const up = (code ?? "").trim().toUpperCase();
  if (!up) return false;
  if (PANEL_MAKER_CODES.has(up)) return false;
  return up in PNP_VENDORS;
}
