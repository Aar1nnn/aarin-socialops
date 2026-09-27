import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireContext } from "../src/lib/auth";
import { disconnectPlatformConnection } from "../src/services/platform-connection-service";
import { POST } from "../src/app/api/connections/[id]/disconnect/route";

vi.mock("../src/lib/auth", () => ({ requireContext: vi.fn() }));
vi.mock("../src/services/platform-connection-service", () => ({ disconnectPlatformConnection: vi.fn() }));

const owner = { clientId: "client-1", userId: "user-1", role: "OWNER" as const };
const params = { params: Promise.resolve({ id: "connection-1" }) };

function jsonRequest(confirmDisconnect?: unknown) {
  return new Request("http://localhost/api/connections/connection-1/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmDisconnect }),
  });
}

beforeEach(() => {
  vi.mocked(requireContext).mockResolvedValue(owner);
  vi.mocked(disconnectPlatformConnection).mockResolvedValue({ disconnected: true, revokeAttempted: true, remoteRevokeConfirmed: true });
  vi.mocked(disconnectPlatformConnection).mockClear();
});

describe("disconnect route confirmation", () => {
  it("rejects missing or false confirmation before invoking the service", async () => {
    for (const value of [undefined, false, "no", "true"]) {
      const response = await POST(jsonRequest(value), params);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "DISCONNECT_CONFIRMATION_REQUIRED" });
    }
    expect(disconnectPlatformConnection).not.toHaveBeenCalled();
  });

  it("accepts explicit JSON and form confirmations", async () => {
    const json = await POST(jsonRequest(true), params);
    expect(json.status).toBe(200);
    const form = await POST(new Request("http://localhost/api/connections/connection-1/disconnect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirmDisconnect: "yes" }),
    }), params);
    expect(form.status).toBe(200);
    expect(disconnectPlatformConnection).toHaveBeenCalledTimes(2);
    expect(disconnectPlatformConnection).toHaveBeenCalledWith(owner, "connection-1");
  });

  it("rejects OPERATOR and VIEWER before disconnecting", async () => {
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      vi.mocked(requireContext).mockResolvedValue({ ...owner, role });
      const response = await POST(jsonRequest(true), params);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "OWNER_REQUIRED" });
    }
    expect(disconnectPlatformConnection).not.toHaveBeenCalled();
  });
});
