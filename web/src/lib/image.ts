import "server-only";

import sharp, { type Sharp } from "sharp";

import type { AllowedImageType } from "@/lib/storage";

/**
 * Image processing for the media library (spec 18, phase 2, AC-8). Runs in the
 * Node upload path (sharp is native, so the route is `runtime = "nodejs"`). On
 * upload we: cap the stored original to a sane maximum edge (never upscaling),
 * apply EXIF orientation, read the real pixel dimensions, and generate a small
 * WebP thumbnail that lists and pickers render instead of the full image.
 *
 * Dedup is unaffected: the SHA-256 is still taken on the *uploaded* bytes before
 * any processing, so identical uploads collapse to one row (see `createOrReuseMedia`).
 */

/** Longest-edge cap for the stored original (keeps a 5 MB upload from also being
   a 6000px monster on disk and over the wire). */
export const MAX_ORIGINAL_DIM = 2000;
/** Longest-edge size for the generated thumbnail. */
export const THUMB_DIM = 400;
/** Longest-edge size for an admin-uploaded software icon (spec 22). */
export const ICON_DIM = 128;

/**
 * Normalize an admin-uploaded software icon (spec 22) to a small PNG: contained
 * within ICON_DIM (never upscaled), EXIF orientation baked in, transparency
 * preserved. Output is always PNG so the serve route can assume `image/png`.
 */
export async function processIcon(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize(ICON_DIM, ICON_DIM, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

export type ProcessedImage = {
  /** The (possibly downscaled) original, re-encoded in its original format. */
  original: Buffer;
  /** The stored original's real dimensions, in pixels. */
  width: number;
  height: number;
  /** A small WebP thumbnail. */
  thumbnail: Buffer;
};

function reencode(pipeline: Sharp, type: AllowedImageType): Sharp {
  switch (type) {
    case "image/png":
      return pipeline.png();
    case "image/jpeg":
      return pipeline.jpeg({ quality: 85 });
    case "image/webp":
      return pipeline.webp({ quality: 85 });
  }
}

export async function processImage(
  bytes: Buffer,
  contentType: AllowedImageType,
): Promise<ProcessedImage> {
  // `failOn: "none"` keeps slightly-malformed-but-renderable images from throwing.
  const original = await reencode(
    sharp(bytes, { failOn: "none" })
      .rotate() // bake in EXIF orientation, then strip it
      .resize(MAX_ORIGINAL_DIM, MAX_ORIGINAL_DIM, {
        fit: "inside",
        withoutEnlargement: true,
      }),
    contentType,
  ).toBuffer();

  const meta = await sharp(original).metadata();

  const thumbnail = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize(THUMB_DIM, THUMB_DIM, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  return {
    original,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    thumbnail,
  };
}
