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
