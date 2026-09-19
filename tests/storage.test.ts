import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "../src/lib/adapters/storage";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("LocalStorageAdapter", () => {
  it("streams bytes, computes metadata and preserves magic-byte detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "socialops-storage-"));
    roots.push(root);
    const adapter = new LocalStorageAdapter(root);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024, 3)]);
    const stored = await adapter.put({ key: "tenant/image.png", body: Readable.from([png.subarray(0, 12), png.subarray(12)]), contentType: "image/png", contentLength: png.length });
    expect(stored.detectedMimeType).toBe("image/png");
    expect(stored.byteSize).toBe(png.length);
    expect((await adapter.metadata("tenant/image.png")).contentLength).toBe(png.length);
    const chunks: Buffer[] = [];
    for await (const chunk of await adapter.getStream("tenant/image.png")) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(png);
  });

  it("blocks traversal outside the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "socialops-storage-"));
    roots.push(root);
    const adapter = new LocalStorageAdapter(root);
    await expect(adapter.getStream("../secret.txt")).rejects.toThrow(/路径无效/);
  });
});
