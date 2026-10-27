import { createHmac, timingSafeEqual } from "node:crypto";

function exportSigningSecret(): string {
  const secret = process.env.SOFTWARE_EXPORT_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "SOFTWARE_EXPORT_SIGNING_SECRET is required for package export file URLs",
    );
  }
  return secret;
}

function canonicalExportPayload(
  packageId: string,
  fileName: string,
  storageKey: string,
  expUnix: number,
): string {
  return `${packageId}\n${fileName}\n${storageKey}\n${expUnix}`;
}

/** Unix expiry timestamp ttlSec from now (default 1 hour). */
export function exportExpiryUnix(ttlSec = 3600): number {
  return Math.floor(Date.now() / 1000) + ttlSec;
}

export function mintExportFileSig(
  packageId: string,
  fileName: string,
  storageKey: string,
  expUnix: number,
): string {
  const payload = canonicalExportPayload(
    packageId,
    fileName,
    storageKey,
    expUnix,
  );
  return createHmac("sha256", exportSigningSecret())
    .update(payload)
    .digest("hex");
}

export function verifyExportFileSig(
  packageId: string,
  fileName: string,
  storageKey: string,
  expUnix: number,
  sig: string,
): boolean {
  if (Math.floor(Date.now() / 1000) > expUnix) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return false;
  }
  const expected = mintExportFileSig(
    packageId,
    fileName,
    storageKey,
    expUnix,
  );
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(sig, "hex"),
    );
  } catch {
    return false;
  }
}
