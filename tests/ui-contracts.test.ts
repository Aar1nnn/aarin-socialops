import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function formContaining(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex, `Expected source to contain ${marker}`).toBeGreaterThanOrEqual(0);

  const formStart = source.lastIndexOf("<form", markerIndex);
  const formEnd = source.indexOf("</form>", markerIndex);
  expect(formStart, `Expected ${marker} to be inside a form`).toBeGreaterThanOrEqual(0);
  expect(formEnd, `Expected the form containing ${marker} to close`).toBeGreaterThan(markerIndex);

  return source.slice(formStart, formEnd + "</form>".length);
}

function expectNamedFields(form: string, names: string[]) {
  names.forEach((name) => expect(form).toContain(`name="${name}"`));
}

const connectionsSource = readSource("../src/app/connections/page.tsx");
const contentSource = readSource("../src/app/content/page.tsx");
const insightsSource = readSource("../src/app/insights/page.tsx");
const settingsSource = readSource("../src/app/settings/page.tsx");

describe("pilot operator UI form contracts", () => {
  describe("platform connections", () => {
    it("preserves the Meta OAuth start return path and owner gate", () => {
      const form = formContaining(connectionsSource, 'action="/api/connections/meta/start"');

      expect(form).toContain('method="post"');
      expect(form).toContain('type="hidden"');
      expect(form).toContain('name="returnTo"');
      expect(form).toContain('value="/connections"');
      expect(form).toContain("disabled={!canManageConnections}");
      expect(connectionsSource).toContain('const canManageConnections = context.role === "OWNER"');
    });

    it("submits repeated accountIds only when account selection is allowed", () => {
      const form = formContaining(connectionsSource, "/select-accounts`}");

      expect(form).toContain('name="accountIds"');
      expect(form).toContain("value={account.id}");
      expect(form).toContain("disabled={!canSelectAccounts}");
      expect(connectionsSource).toContain("canManageConnections && connectionReady");
    });

    it("requires an explicit confirmation before disconnecting credentials", () => {
      const form = formContaining(connectionsSource, "/disconnect`}");

      expect(form).toContain('method="post"');
      expect(form).toContain('type="checkbox"');
      expect(form).toMatch(/\brequired\b/);
      expect(form).toContain("disabled={!canManageConnections");
    });
  });

  describe("content workflow", () => {
    it("preserves draft generation inputs and viewer restrictions", () => {
      const form = formContaining(contentSource, 'action="/api/content/generate"');

      expectNamedFields(form, ["productId", "theme", "objective", "accountIds"]);
      expect(form).toContain("disabled={readOnly}");
      expect(contentSource).toContain('const readOnly = context.role === "VIEWER"');
    });

    it("preserves explicit approve and reject decisions", () => {
      expect(contentSource).toContain('name="decision" value="APPROVED"');
      expect(contentSource).toContain('name="decision" value="REJECTED"');
      expect(contentSource.match(/\/review`} method="post"/g)).toHaveLength(2);
    });

    it("preserves publish mode, local time, and workspace timezone", () => {
      const form = formContaining(contentSource, "/schedule`}");

      expectNamedFields(form, ["publishMode", "localDateTime", "timezone"]);
      expect(form).toContain('type="datetime-local"');
      expect(form).toContain("value={client.timezone}");
      expect(form).toContain('value="NOW"');
      expect(form).toContain('value="SCHEDULED"');
      expect(form).toContain('client.mode === "DRAFT"');
    });

    it("keeps remote status lookup read-only for viewers", () => {
      const form = formContaining(contentSource, "/query`}");

      expect(form).toContain('method="post"');
      expect(form).toContain("disabled={readOnly}");
    });
  });

  describe("leads and data", () => {
    it("derives every write gate from the authenticated workspace role", () => {
      expect(insightsSource).toContain("const hasWriteAccess = canWrite(context.role)");
      expect(insightsSource).toContain("disabled={!hasWriteAccess}");
      expect(insightsSource).toContain("disabled={!hasWriteAccess || importPlatforms.length === 0}");
    });

    it("preserves account-scoped metric sync", () => {
      const form = formContaining(insightsSource, 'action="/api/facebook/metrics/sync"');

      expect(form).toContain('type="hidden"');
      expect(form).toContain('name="accountId"');
      expect(form).toContain("value={account.id}");
      expect(form).toContain("disabled={!hasWriteAccess}");
      expect(insightsSource).toContain('account.metricsCapability === "VERIFIED"');
    });

    it("preserves publish-job scoping and capability gates for live sync", () => {
      const metricsForm = formContaining(insightsSource, 'action="/api/facebook/post-metrics/sync"');
      const commentsForm = formContaining(insightsSource, 'action="/api/facebook/comments/sync"');

      for (const form of [metricsForm, commentsForm]) {
        expect(form).toContain('type="hidden"');
        expect(form).toContain('name="publishJobId"');
        expect(form).toContain("value={job.id}");
        expect(form).toContain("disabled={!hasWriteAccess");
      }
      expect(metricsForm).toContain('job.account.metricsCapability !== "VERIFIED"');
      expect(commentsForm).toContain('job.account.commentsCapability !== "VERIFIED"');
    });
  });

  describe("workspace settings", () => {
    it("keeps one canonical workspace settings endpoint", () => {
      expect(settingsSource.match(/action="\/api\/settings"/g)).toHaveLength(1);
      expect(settingsSource).toContain('id="workspace-settings-form"');
      expect(settingsSource).toContain('form="workspace-settings-form"');
    });

    it("limits workspace configuration changes to owners", () => {
      expect(settingsSource).toContain('const isOwner = context.role === "OWNER"');
      expect(settingsSource).toContain("disabled={!isOwner}");
      expect(settingsSource).toContain('name="timezone"');
      expect(settingsSource).toContain('name="mode"');
      expect(settingsSource).toContain('name="usageMonthlyLimit"');
      expect(settingsSource).toContain('name="textProvider"');
    });
  });
});
