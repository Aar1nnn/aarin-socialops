import { describe, expect, it } from "vitest";
import { safeErrorMessage, TokenVault, redactSensitiveData, redactSensitiveText } from "../src/lib/token-vault";

describe("TokenVault", () => {
  it("encrypts with authenticated encryption and round trips", () => {
    const vault = new TokenVault(new Map([["test-v1", Buffer.alloc(32, 7)]]), "test-v1");
    const encrypted = vault.encrypt("page-token-value");
    expect(encrypted.ciphertext).not.toContain("page-token-value");
    expect(encrypted.keyVersion).toBe("test-v1");
    expect(vault.decrypt(encrypted)).toBe("page-token-value");
  });

  it("rejects tampered ciphertext", () => {
    const vault = new TokenVault(new Map([["test-v1", Buffer.alloc(32, 8)]]), "test-v1");
    const encrypted = vault.encrypt("sensitive");
    encrypted.authTag = Buffer.alloc(16, 1).toString("base64");
    expect(() => vault.decrypt(encrypted)).toThrow(/完整性校验失败/);
  });

  it("rejects a wrong key and empty secret", () => {
    const first = new TokenVault(new Map([["test-v1", Buffer.alloc(32, 8)]]), "test-v1");
    const second = new TokenVault(new Map([["test-v1", Buffer.alloc(32, 9)]]), "test-v1");
    const encrypted = first.encrypt("sensitive");
    expect(() => second.decrypt(encrypted)).toThrow(/完整性校验失败/);
    expect(() => first.encrypt("   ")).toThrow(/空凭据/);
  });

  it("redacts secret-shaped values and sensitive keys", () => {
    expect(redactSensitiveText("Bearer abc.def.ghi EAA12345678901234567890")).not.toContain("EAA123");
    expect(redactSensitiveData({ accessToken: "plain", nested: { message: "EAA12345678901234567890" } })).toEqual({
      accessToken: "[REDACTED]",
      nested: { message: "[REDACTED]" },
    });
    expect(safeErrorMessage(new Error("request failed: Bearer abc.def.ghi EAA12345678901234567890"))).not.toContain("EAA123");
  });
});
