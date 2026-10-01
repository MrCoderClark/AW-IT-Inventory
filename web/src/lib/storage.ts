import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";

/**
 * S3-compatible object storage for uploaded asset photos (spec 17.02). We talk
 * the standard S3 API through `@aws-sdk/client-s3`, so any self-hosted
 * S3-compatible store (Garage, SeaweedFS, ...) works; the concrete store is a
 * deployment choice, set by env, not a code dependency. `forcePathStyle` is
 * always on, because self-hosted stores address buckets by path, not virtual
 * host. The bucket stays private: bytes are only served through the app's
 * authenticated GET route, never a public URL.
 *
 * Config (gitignored `web/.env`):
 *   S3_ENDPOINT, S3_REGION (default us-east-1), S3_ACCESS_KEY_ID,
 *   S3_SECRET_ACCESS_KEY, S3_BUCKET
 */

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_TYPES)[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (spec 17.02, AC-2.1)

const EXT_BY_TYPE: Record<AllowedImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** True when the given MIME type is an accepted upload (spec 17.02, AC-2.3). */
export function isAllowedImageType(type: string): type is AllowedImageType {
  return (ALLOWED_TYPES as readonly string[]).includes(type);
}

function readEnv(): {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} | null {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

/** True when the object store is configured (all required env present). Lets the
   UI and routes degrade with a clear message instead of a stack trace. */
export function isStorageConfigured(): boolean {
  return readEnv() !== null;
}

let cached: { client: S3Client; bucket: string } | null = null;

function connect(): { client: S3Client; bucket: string } {
  if (cached) return cached;
  const cfg = readEnv();
  if (!cfg) {
    throw new Error(
      "Object storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET.",
    );
  }
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
  cached = { client, bucket: cfg.bucket };
  return cached;
}

let bucketEnsured = false;

/** Make sure the target bucket exists, creating it on first use (spec 17.02).
   Idempotent and memoized, so the hot upload path pays the check only once. */
export async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const { client, bucket } = connect();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    // Not found (or no access to head it): try to create it. If it already
    // exists and is owned by us, the create is a harmless no-op we ignore.
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (!isBucketAlreadyOwned(err)) throw err;
    }
  }
  bucketEnsured = true;
}

function isBucketAlreadyOwned(err: unknown): boolean {
  const name =
    typeof err === "object" && err && "name" in err
      ? String((err as { name?: unknown }).name)
      : "";
  return (
    name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists"
  );
}

/** A random, unguessable object key for one asset's image. The extension tracks
   the content type so the stored object is self-describing. */
export function newImageKey(assetId: string, type: AllowedImageType): string {
  return `assets/${assetId}/${randomBytes(16).toString("hex")}.${EXT_BY_TYPE[type]}`;
}

/** The object key for a media-library image (spec 18): `media/{id}/image.{ext}`.
   Stable per media row (the id is already random), so no random suffix is needed. */
export function newMediaObjectKey(
  mediaId: string,
  type: AllowedImageType,
): string {
  return `media/${mediaId}/image.${EXT_BY_TYPE[type]}`;
}

/** Hex SHA-256 of an image's bytes — the media dedup key (spec 18, AC-3). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Store an image under `key`. Ensures the bucket first. */
export async function putImage(
  key: string,
  body: Buffer,
  contentType: AllowedImageType,
): Promise<void> {
  await ensureBucket();
  const { client, bucket } = connect();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Read an object's bytes + content type, or null when the key is missing. The
   image is <= 5 MB, so buffering the whole object is cheaper and simpler than
   plumbing a stream through the route. */
export async function getImageBytes(
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const { client, bucket } = connect();
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { bytes, contentType: res.ContentType || "application/octet-stream" };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Delete an object. Missing keys are ignored (idempotent), so cleanup never
   throws just because the object is already gone. */
export async function removeImage(key: string): Promise<void> {
  const { client, bucket } = connect();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = "name" in err ? String((err as { name?: unknown }).name) : "";
  const status =
    "$metadata" in err
      ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
      : undefined;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
