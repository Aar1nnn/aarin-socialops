import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/lib/context";
import type { PlatformAuthAdapter } from "../src/lib/adapters/platform-auth";
import { db } from "../src/lib/db";
import { TokenVault } from "../src/lib/token-vault";
import { listAccountOperations } from "../src/services/account-operations-view";
import {
  completePlatformConnection,
  disconnectPlatformConnection,
  normalizeAccountIdSet,
  selectPlatformAccounts,
  startPlatformConnection,
} from "../src/services/platform-connection-service";

const clientIds: string[] = [];
const userIds: string[] = [];

async function fixture() {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `accounts-${suffix}`, name: `Accounts ${suffix}`, mode: "DRAFT" } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `accounts-${suffix}@example.local`, displayName: "Owner", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const context: RequestContext = { clientId: client.id, userId: user.id, role: "OWNER" };
  const vault = new TokenVault(new Map([["test-v1", Buffer.alloc(32, 9)]]), "test-v1");
  const secret = vault.encrypt("old-user-token");
  const connection = await db.platformConnection.create({ data: {
    clientId: client.id, provider: "META", externalPrincipalId: `principal-${suffix}`,
    status: "CONNECTED", connectedByUserId: user.id,
    accessTokenCiphertext: secret.ciphertext, accessTokenIv: secret.iv,
    accessTokenAuthTag: secret.authTag, tokenKeyVersion: secret.keyVersion,
  } });
  const selected = await db.socialAccount.create({ data: {
    clientId: client.id, platformConnectionId: connection.id, platform: "facebook", displayName: "Selected Page",
    externalAccountId: `selected-${suffix}`, isSelected: true,
    accessTokenCiphertext: secret.ciphertext, accessTokenIv: secret.iv, accessTokenAuthTag: secret.authTag,
    publishCapability: "VERIFIED", providerCapabilities: { canPublish: true },
  } });
  const other = await db.socialAccount.create({ data: {
    clientId: client.id, platformConnectionId: connection.id, platform: "facebook", displayName: "Other Page",
    externalAccountId: `other-${suffix}`, isSelected: false,
    providerCapabilities: { canPublish: true },
  } });
  return { client, user, context, connection, selected, other, vault, secret };
}

async function makeJob(input: Awaited<ReturnType<typeof fixture>>, adapter = "meta-facebook") {
  const plan = await db.contentPlan.create({ data: {
    clientId: input.client.id, theme: "Account protection", objective: "Test", channels: ["facebook"],
  } });
  const item = await db.contentItem.create({ data: {
    clientId: input.client.id, planId: plan.id, accountId: input.selected.id, platform: "facebook",
  } });
  const version = await db.contentVersion.create({ data: {
    clientId: input.client.id, contentItemId: item.id, version: 1, text: "Test content",
    generator: "TEST", generationLabel: "TEST", sourceFacts: {},
  } });
  await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  return db.publishJob.create({ data: {
    clientId: input.client.id, contentVersionId: version.id, accountId: input.selected.id,
    status: "PENDING", adapter, environment: "LIVE", simulated: false, idempotencyKey: randomUUID(),
  } });
}

afterEach(async () => {
  for (const id of clientIds.splice(0)) await db.client.deleteMany({ where: { id } });
  for (const id of userIds.splice(0)) await db.user.deleteMany({ where: { id } });
});
afterAll(async () => { await db.$disconnect(); });

describe("account operations", () => {
  it("uses set semantics for selection and rejects a stale editor", async () => {
    const input = await fixture();
    expect(normalizeAccountIdSet([" B ", "A", "Ｂ", "A"])).toEqual(["A", "B"]);
    await selectPlatformAccounts(input.context, input.connection.id, [input.other.id, input.selected.id, input.other.id], [input.selected.id]);
    await expect(selectPlatformAccounts(input.context, input.connection.id, [input.other.id], [])).rejects.toMatchObject({ code: "ACCOUNT_SELECTION_CONFLICT", status: 409 });
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: input.selected.id } })).isSelected).toBe(true);
    await selectPlatformAccounts(input.context, input.connection.id, [input.other.id], [input.other.id, input.selected.id]);
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: input.selected.id } })).isSelected).toBe(false);
    const third = await db.socialAccount.create({ data: {
      clientId: input.client.id, platformConnectionId: input.connection.id, platform: "facebook",
      displayName: "Third Page", externalAccountId: `third-${randomUUID()}`, isSelected: false,
      providerCapabilities: { canPublish: true },
    } });
    const concurrent = await Promise.allSettled([
      selectPlatformAccounts(input.context, input.connection.id, [input.selected.id], [input.other.id]),
      selectPlatformAccounts(input.context, input.connection.id, [third.id], [input.other.id]),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "ACCOUNT_SELECTION_CONFLICT" });
  });

  it("protects every active API status before selection, reconnect, local clear or remote revoke", async () => {
    const input = await fixture();
    const job = await makeJob(input);
    let revokeCalls = 0;
    const adapter: PlatformAuthAdapter = {
      provider: "META",
      buildAuthorizationUrl(request) { return new URL(`https://www.facebook.com/dialog/oauth?state=${request.state}`); },
      async exchangeCode() { return { accessToken: "new-user-token", scopes: [] }; },
      async discoverAccounts() { return {
        externalPrincipalId: input.connection.externalPrincipalId!, grantedScopes: [],
        accounts: [{ externalAccountId: input.selected.externalAccountId!, platform: "facebook", accountType: "FACEBOOK_PAGE", displayName: "Selected Page", accessToken: "new-page-token", capabilities: { canPublish: true }, metadata: {} }],
      }; },
      async revoke() { revokeCalls += 1; },
    };
    for (const status of ["PENDING", "RETRY", "WAITING_CONFIGURATION", "RUNNING", "UNKNOWN"] as const) {
      await db.publishJob.update({ where: { id: job.id }, data: { status } });
      await expect(selectPlatformAccounts(input.context, input.connection.id, [input.other.id], [input.selected.id])).rejects.toMatchObject({ code: "ACCOUNT_ACTIVE_PUBLISH_JOBS", status: 409 });
      await expect(disconnectPlatformConnection(input.context, input.connection.id, { adapter, vault: input.vault })).rejects.toMatchObject({ code: "ACCOUNT_ACTIVE_PUBLISH_JOBS", status: 409 });
      expect(revokeCalls).toBe(0);
      expect(await db.platformConnection.findUniqueOrThrow({ where: { id: input.connection.id } })).toMatchObject({ status: "CONNECTED", accessTokenCiphertext: input.secret.ciphertext });
      expect((await db.socialAccount.findUniqueOrThrow({ where: { id: input.selected.id } })).isSelected).toBe(true);
    }
    const priorRedirect = process.env.META_REDIRECT_URI;
    process.env.META_REDIRECT_URI = "https://app.example.test/api/connections/meta/callback";
    try {
      const start = await startPlatformConnection(input.context, "META", "/connections", adapter);
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      await expect(completePlatformConnection(input.context, "META", { code: "reconnect", state }, { adapter, vault: input.vault })).rejects.toMatchObject({ code: "ACCOUNT_ACTIVE_PUBLISH_JOBS", status: 409 });
      expect(revokeCalls).toBe(0);
      expect((await db.socialAccount.findUniqueOrThrow({ where: { id: input.selected.id } })).isSelected).toBe(true);
    } finally {
      if (priorRedirect === undefined) delete process.env.META_REDIRECT_URI;
      else process.env.META_REDIRECT_URI = priorRedirect;
    }
    await db.publishJob.update({ where: { id: job.id }, data: { status: "PUBLISHED" } });
    await expect(selectPlatformAccounts(input.context, input.connection.id, [input.other.id], [input.selected.id])).resolves.toMatchObject({ id: input.connection.id });
  });

  it("does not treat DEMO/mock-social jobs as real LIVE API dispatches", async () => {
    const input = await fixture();
    const job = await makeJob(input, "mock-social");
    await db.publishJob.update({ where: { id: job.id }, data: { status: "UNKNOWN", environment: "SIMULATED", simulated: true } });
    await expect(selectPlatformAccounts(input.context, input.connection.id, [input.other.id], [input.selected.id])).resolves.toMatchObject({ id: input.connection.id });
    let revokeCalls = 0;
    const adapter: PlatformAuthAdapter = {
      provider: "META",
      buildAuthorizationUrl() { return new URL("https://example.test"); },
      async exchangeCode() { throw new Error("unused"); },
      async discoverAccounts() { throw new Error("unused"); },
      async revoke() { revokeCalls += 1; },
    };
    await expect(disconnectPlatformConnection(input.context, input.connection.id, { adapter, vault: input.vault })).resolves.toEqual({
      disconnected: true, revokeAttempted: true, remoteRevokeConfirmed: true,
    });
    expect(revokeCalls).toBe(1);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("UNKNOWN");
  });

  it("uses historical job.adapter and records remote revoke warning after local disconnect", async () => {
    const input = await fixture();
    await makeJob(input, "manual");
    const adapter: PlatformAuthAdapter = {
      provider: "META",
      buildAuthorizationUrl() { return new URL("https://example.test"); },
      async exchangeCode() { throw new Error("unused"); },
      async discoverAccounts() { throw new Error("unused"); },
      async revoke() {
        const local = await db.platformConnection.findUniqueOrThrow({ where: { id: input.connection.id } });
        expect(local.status).toBe("DISCONNECTED");
        expect(local.accessTokenCiphertext).toBeNull();
        throw new Error("remote unavailable");
      },
    };
    await expect(disconnectPlatformConnection(input.context, input.connection.id, { adapter, vault: input.vault })).resolves.toEqual({ disconnected: true, revokeAttempted: true, remoteRevokeConfirmed: false });
    expect(await db.platformConnection.findUniqueOrThrow({ where: { id: input.connection.id } })).toMatchObject({ status: "DISCONNECTED", accessTokenCiphertext: null });
    expect(await db.auditLog.findFirst({ where: { clientId: input.client.id, entityId: input.connection.id, action: "PLATFORM_REMOTE_REVOKE_RESULT" } })).toMatchObject({
      metadata: { revokeAttempted: true, remoteRevokeConfirmed: false },
    });
  });

  it("keeps local disconnect successful without claiming remote revoke when token material is absent", async () => {
    const input = await fixture();
    await db.platformConnection.update({ where: { id: input.connection.id }, data: {
      accessTokenCiphertext: null, accessTokenIv: null, accessTokenAuthTag: null,
    } });
    let revokeCalls = 0;
    const adapter: PlatformAuthAdapter = {
      provider: "META",
      buildAuthorizationUrl() { return new URL("https://example.test"); },
      async exchangeCode() { throw new Error("unused"); },
      async discoverAccounts() { throw new Error("unused"); },
      async revoke() { revokeCalls += 1; },
    };
    await expect(disconnectPlatformConnection(input.context, input.connection.id, { adapter, vault: input.vault })).resolves.toEqual({
      disconnected: true, revokeAttempted: false, remoteRevokeConfirmed: false,
    });
    expect(revokeCalls).toBe(0);
    expect(await db.platformConnection.findUniqueOrThrow({ where: { id: input.connection.id } })).toMatchObject({
      status: "DISCONNECTED", accessTokenCiphertext: null, lastErrorCode: "REMOTE_REVOKE_NOT_ATTEMPTED",
    });
    expect(await db.auditLog.findFirst({ where: { clientId: input.client.id, entityId: input.connection.id, action: "PLATFORM_REMOTE_REVOKE_RESULT" } })).toMatchObject({
      metadata: { revokeAttempted: false, remoteRevokeConfirmed: false, warningCode: "REMOTE_REVOKE_NOT_ATTEMPTED" },
    });
  });

  it("keeps account reads tenant scoped and writes OWNER only", async () => {
    const first = await fixture();
    const second = await fixture();
    const rows = await listAccountOperations(first.context);
    expect(rows.map((row) => row.id)).toEqual([first.other.id, first.selected.id]);
    expect(rows.some((row) => row.id === second.selected.id)).toBe(false);
    expect(rows.find((row) => row.id === first.selected.id)).toMatchObject({ mode: "API", health: "API_SELECTED", nextHref: "/content" });
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      const context = { ...first.context, role };
      await expect(selectPlatformAccounts(context, first.connection.id, [first.selected.id], [first.selected.id])).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      await expect(disconnectPlatformConnection(context, first.connection.id)).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      expect((await listAccountOperations(context)).length).toBe(2);
    }
    await expect(selectPlatformAccounts(second.context, first.connection.id, [first.selected.id], [])).rejects.toMatchObject({ code: "PLATFORM_CONNECTION_NOT_FOUND" });
  });
});
