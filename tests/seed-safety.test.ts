import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { seedDatabase } from "../prisma/seed";

const realClientSnapshot = {
  id: true,
  slug: true,
  name: true,
  mode: true,
  timezone: true,
  targetMarkets: true,
  productFocus: true,
  brandGuidelines: true,
  contactDetails: true,
  usageMonthlyLimit: true,
  isDemo: true,
  configurationStatus: true,
} as const;

describe("seed safety", () => {
  it("does not mutate existing real clients while preparing fixtures", async () => {
    const suffix = randomUUID();
    const realClients = await Promise.all([
      db.client.create({
        data: {
          slug: `real-client-a-${suffix}`,
          name: "Real Client A",
          mode: "LIVE",
          timezone: "Asia/Kuala_Lumpur",
          targetMarkets: ["US", "GB"],
          productFocus: "Wholesale seating",
          brandGuidelines: "Keep verified wording only",
          contactDetails: { email: "real-a@example.test" },
          usageMonthlyLimit: 12345,
          isDemo: false,
          configurationStatus: "REAL_A_READY",
        },
        select: realClientSnapshot,
      }),
      db.client.create({
        data: {
          slug: `real-client-b-${suffix}`,
          name: "Real Client B",
          mode: "DRAFT",
          timezone: "Europe/London",
          targetMarkets: ["DE"],
          productFocus: "Wholesale tables",
          brandGuidelines: "No unconfirmed claims",
          contactDetails: { email: "real-b@example.test" },
          usageMonthlyLimit: 54321,
          isDemo: false,
          configurationStatus: "REAL_B_PENDING",
        },
        select: realClientSnapshot,
      }),
    ]);

    try {
      await seedDatabase(db, { ...process.env, NODE_ENV: "test" });
      const after = await db.client.findMany({
        where: { id: { in: realClients.map((client) => client.id) } },
        orderBy: { id: "asc" },
        select: realClientSnapshot,
      });
      expect(after).toEqual([...realClients].sort((left, right) => left.id.localeCompare(right.id)));
    } finally {
      await db.client.deleteMany({ where: { id: { in: realClients.map((client) => client.id) } } });
    }
  });

  it("rejects production seed before the first database write without explicit authorization", async () => {
    const upsert = vi.fn();
    await expect(seedDatabase({ client: { upsert } } as never, { NODE_ENV: "production" })).rejects.toThrow(
      "ALLOW_PRODUCTION_SEED=true",
    );
    await expect(
      seedDatabase(
        { client: { upsert } } as never,
        { NODE_ENV: "production", ALLOW_PRODUCTION_SEED: "true" },
      ),
    ).rejects.toThrow("拒绝使用默认 seed 密码");
    expect(upsert).not.toHaveBeenCalled();
  });
});
