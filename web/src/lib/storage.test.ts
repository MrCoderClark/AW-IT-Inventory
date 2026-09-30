import { describe, it, expect, afterEach } from "vitest";

import {
  isAllowedImageType,
  isStorageConfigured,
  newImageKey,
  MAX_IMAGE_BYTES,
} from "./storage";

/**
 * Unit tests for the pure storage helpers (spec 17.02): the accepted types, the
 * 5 MB limit, the object key shape, and the env-driven configuration gate. The
 * S3 client itself (put/get/remove) talks to a real store and is covered at the
 * route level with mocks.
 */

describe("isAllowedImageType (AC-2.3)", () => {
  it("accepts PNG, JPEG, and WebP only", () => {
    expect(isAllowedImageType("image/png")).toBe(true);
    expect(isAllowedImageType("image/jpeg")).toBe(true);
    expect(isAllowedImageType("image/webp")).toBe(true);
    expect(isAllowedImageType("image/gif")).toBe(false);
    expect(isAllowedImageType("text/plain")).toBe(false);
    expect(isAllowedImageType("")).toBe(false);
  });
});

describe("MAX_IMAGE_BYTES (AC-2.1)", () => {
  it("is 5 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("newImageKey", () => {
  it("builds a random, unguessable key under the asset with the right extension", () => {
    expect(newImageKey("id1", "image/png")).toMatch(
      /^assets\/id1\/[0-9a-f]{32}\.png$/,
    );
    expect(newImageKey("id1", "image/jpeg")).toMatch(
      /^assets\/id1\/[0-9a-f]{32}\.jpg$/,
    );
    expect(newImageKey("id1", "image/webp")).toMatch(
      /^assets\/id1\/[0-9a-f]{32}\.webp$/,
    );
  });

  it("does not repeat keys", () => {
    expect(newImageKey("id1", "image/png")).not.toBe(
      newImageKey("id1", "image/png"),
    );
  });
});

describe("isStorageConfigured", () => {
  const keys = [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_BUCKET",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is false when any required env var is missing", () => {
    for (const k of keys) delete process.env[k];
    expect(isStorageConfigured()).toBe(false);
    process.env.S3_ENDPOINT = "http://localhost:3900";
    expect(isStorageConfigured()).toBe(false); // still missing credentials/bucket
  });

  it("is true when endpoint, credentials, and bucket are all set", () => {
    process.env.S3_ENDPOINT = "http://localhost:3900";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "opus-assets";
    expect(isStorageConfigured()).toBe(true);
  });
});
