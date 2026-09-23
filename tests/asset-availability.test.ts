import { describe, expect, it } from "vitest";
import {
  assessAssetExternalRead,
  assessExternalReadUrl,
  externalReadDescriptor,
  S3CompatibleStorageAdapter,
} from "../src/lib/adapters/storage";

const now = new Date("2026-09-23T00:00:00.000Z");

function publicCandidate(url: string) {
  return assessExternalReadUrl(url, {
    candidateType: "PUBLIC_HTTPS",
    source: "METADATA_PUBLIC_URL",
    fallbackAvailability: "PRIVATE_REMOTE",
    now,
  });
}

function signedCandidate(url: string, explicitExpiresAt?: unknown) {
  return assessExternalReadUrl(url, {
    candidateType: "SIGNED_HTTPS",
    source: "METADATA_SIGNED_URL",
    fallbackAvailability: "PRIVATE_REMOTE",
    explicitExpiresAt,
    now,
  });
}

describe("asset external-read availability", () => {
  it("marks a safe HTTPS URL only as an unverified external-read candidate", () => {
    const assessment = publicCandidate("https://cdn.example.test/media/photo.jpg");
    expect(assessment).toMatchObject({
      availability: "PUBLIC_HTTPS",
      ready: true,
      externalValidation: "NOT_EXTERNALLY_VERIFIED",
      reason: "READY_CANDIDATE",
    });
    expect(externalReadDescriptor(assessment)).not.toHaveProperty("url");
  });

  it.each([
    ["http://cdn.example.test/file.jpg", "HTTPS_REQUIRED"],
    ["https://user:secret@cdn.example.test/file.jpg", "URL_CREDENTIALS_FORBIDDEN"],
    ["https://localhost/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://assets.local/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://127.0.0.1/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://10.2.3.4/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://172.31.2.3/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://192.168.1.2/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://169.254.10.20/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://[::1]/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://[fe80::1]/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://[fd00::1]/file.jpg", "HOST_NOT_PUBLIC"],
    ["https://[::ffff:127.0.0.1]/file.jpg", "HOST_NOT_PUBLIC"],
  ])("rejects an address that an external platform must not fetch: %s", (url, reason) => {
    expect(publicCandidate(url)).toMatchObject({
      availability: "PRIVATE_REMOTE",
      ready: false,
      externalValidation: "NOT_EXTERNALLY_VERIFIED",
      reason,
    });
  });

  it("recognizes AWS-style expiry and enforces the safety margin", () => {
    const base = "https://objects.example.test/bucket/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260923T000000Z&X-Amz-Signature=test";
    expect(signedCandidate(`${base}&X-Amz-Expires=3600`)).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: true,
      expiresAt: "2026-09-23T01:00:00.000Z",
    });
    expect(signedCandidate(`${base}&X-Amz-Expires=600`)).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: false,
      reason: "SIGNED_URL_EXPIRES_TOO_SOON",
    });
    expect(signedCandidate(`${base.replace("20260923T000000Z", "20260922T220000Z")}&X-Amz-Expires=3600`)).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: false,
      reason: "SIGNED_URL_EXPIRED",
    });
  });

  it("recognizes explicit and common signed expiry formats", () => {
    expect(signedCandidate("https://signed.example.test/opaque", "2026-09-23T02:00:00Z")).toMatchObject({ ready: true });
    expect(publicCandidate("https://blob.example.test/file.jpg?sv=1&se=2026-09-23T02%3A00%3A00Z&sig=test")).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: true,
      expiresAt: "2026-09-23T02:00:00.000Z",
    });
    expect(publicCandidate("https://cdn.example.test/file.jpg?Expires=1790208000&Signature=test")).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: true,
    });
  });

  it("does not declare an opaque or invalid signed expiry ready", () => {
    expect(signedCandidate("https://signed.example.test/file.jpg?X-Amz-Signature=test")).toMatchObject({
      ready: false,
      reason: "SIGNED_URL_EXPIRY_UNKNOWN",
    });
    expect(signedCandidate("https://signed.example.test/file.jpg", "2026-09-23 02:00:00")).toMatchObject({
      ready: false,
      reason: "SIGNED_URL_EXPIRY_INVALID",
    });
  });

  it("uses the same assessment for asset metadata and preserves non-candidate storage states", () => {
    expect(assessAssetExternalRead({ storageProvider: "local", storageKey: "asset/file.jpg", metadata: null }, { now })).toMatchObject({
      availability: "LOCAL_ONLY",
      ready: false,
      reason: "LOCAL_STORAGE",
    });
    expect(assessAssetExternalRead({ storageProvider: "s3", storageKey: "asset/file.jpg", metadata: {} }, { now })).toMatchObject({
      availability: "PRIVATE_REMOTE",
      ready: false,
      reason: "REMOTE_URL_MISSING",
    });
    expect(assessAssetExternalRead({
      storageProvider: "s3",
      storageKey: "asset/file.jpg",
      metadata: { signedUrl: "https://signed.example.test/file.jpg", signedUrlExpiresAt: "2026-09-23T00:05:00Z" },
    }, { now })).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: false,
      reason: "SIGNED_URL_EXPIRES_TOO_SOON",
      externalValidation: "NOT_EXTERNALLY_VERIFIED",
    });
  });

  it("assesses a freshly generated S3-compatible URL at the storage boundary", async () => {
    const storage = new S3CompatibleStorageAdapter({
      endpoint: "https://objects.example.test",
      bucket: "media",
      region: "test-1",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const assessment = await storage.getExternalRead("tenant/photo.jpg", { expiresSeconds: 3_600 });
    expect(assessment).toMatchObject({
      availability: "SIGNED_HTTPS",
      ready: true,
      externalValidation: "NOT_EXTERNALLY_VERIFIED",
      source: "STORAGE_SIGNED_URL",
      reason: "READY_CANDIDATE",
    });
    expect(assessment.url).toContain("X-Amz-Signature=");
  });
});
