import { describe, expect, it } from "vitest";
import { zonedLocalDateTimeToUtc } from "../src/lib/timezone";

describe("timezone scheduling", () => {
  it("converts an operator local time to UTC", () => {
    expect(zonedLocalDateTimeToUtc("2026-09-20T09:30", "Asia/Shanghai").toISOString()).toBe("2026-09-20T01:30:00.000Z");
  });

  it("rejects a DST gap instead of silently moving the time", () => {
    expect(() => zonedLocalDateTimeToUtc("2026-03-08T02:30", "America/New_York")).toThrow(/不存在|歧义/);
  });

  it("rejects a repeated DST time instead of choosing one UTC instant silently", () => {
    expect(() => zonedLocalDateTimeToUtc("2026-11-01T01:30", "America/New_York")).toThrow(/歧义/);
  });
});
