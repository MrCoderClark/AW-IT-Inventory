/** RFC 5987-friendly attachment header (ASCII fallback + UTF-8 filename*). */
export function attachmentContentDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[\u0000-\u001f\u007f"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(fileName)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
