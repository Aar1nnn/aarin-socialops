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
const contentDetailSource = readSource("../src/app/content/[id]/page.tsx");
const contentActionsSource = readSource("../src/components/content-actions.tsx");
const contentViewSource = readSource("../src/services/content-operations-view.ts");
const insightsSource = readSource("../src/app/insights/page.tsx");
const settingsSource = readSource("../src/app/settings/page.tsx");
const primaryNavSource = readSource("../src/components/primary-nav.tsx");
const strategySource = readSource("../src/app/strategy/page.tsx");
const strategyApiSource = readSource("../src/app/api/social-strategies/route.ts");

describe("pilot operator UI form contracts", () => {
  describe("social strategy", () => {
    it("pins draft edits and gives stale editors a refresh path", () => {
      const form = formContaining(strategySource, 'name="expectedDraftId"');
      expect(form).toContain('action="/api/social-strategies"');
      expect(form).toContain('value={draft?.id || ""}');
      expect(strategyApiSource).toContain('error.code === "STRATEGY_VERSION_CONFLICT"');
      expect(strategySource).toContain('error === "STRATEGY_VERSION_CONFLICT"');
      expect(strategySource).toContain('刷新页面');
    });

    it("uses the confirmed-strategy gate code on both relevant pages", () => {
      expect(strategySource).toContain('data-error-code="CONFIRMED_STRATEGY_REQUIRED"');
      expect(contentSource).toContain('data-error-code="CONFIRMED_STRATEGY_REQUIRED"');
    });
  });

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
      expect(contentSource).toContain('const readOnly = context.role === "VIEWER"');
      expect(contentSource).toContain('{!readOnly ? <details');
      expect(contentSource).toContain('href={`/content/${item.id}`}');
    });

    it("scopes list and detail reads to the current client", () => {
      expect(contentViewSource).toContain('clientId: context.clientId');
      expect(contentViewSource).toContain('where: { id, clientId: context.clientId }');
      expect(contentDetailSource).toContain('if (!item) notFound()');
    });

    it("separates AI review from human approval and requires expected version on writes", () => {
      expect(contentDetailSource).toContain('title="AI 检查"');
      expect(contentDetailSource).toContain('title="人工审核与修改意见"');
      expect(contentActionsSource).toContain('expectedVersionId: props.versionId');
      expect(contentActionsSource).toContain('operation: "rewrite"');
      expect(contentActionsSource).toContain('operation: "regenerate_platform"');
      expect(contentActionsSource).toContain('operation: "update_draft"');
      expect(contentActionsSource).toContain('decision: "APPROVED"');
      expect(contentActionsSource).toContain('"changes"');
      expect(contentActionsSource).toContain('"versions"');
      expect(contentActionsSource).toContain('"schedule"');
      expect(contentActionsSource).toContain('response.status === 409');
    });

    it("keeps scheduling behind role, approval and workspace gates", () => {
      expect(contentActionsSource).toContain('!props.readOnly && props.status === "APPROVED" && props.approved && props.mode !== "DRAFT"');
      expect(contentActionsSource).toContain('type="datetime-local"');
      expect(contentActionsSource).toContain('timezone: props.timezone');
      expect(contentActionsSource).toContain('props.mode === "LIVE" && !liveConfirmed');
      expect(contentDetailSource).toContain('job.status === "UNKNOWN"');
      expect(contentDetailSource).toContain('不能盲目重试');
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

    it("keeps the non-publishing foundation routes in the integrated navigation", () => {
      expect(primaryNavSource).toContain('{ href: "/calendar", label: "内容日历"');
      expect(primaryNavSource).toContain('{ href: "/brand", label: "品牌与知识"');
      expect(primaryNavSource).toContain('{ href: "/analytics", label: "数据分析"');
      expect(primaryNavSource).toContain('{ href: "/accounts", label: "平台与账号"');
      expect(primaryNavSource).toContain('{ href: "/publishing", label: "发布中心"');
    });

    it("preserves external notification channel setup outside the workspace form", () => {
      const form = formContaining(settingsSource, 'action="/api/notifications/channels"');

      expectNamedFields(form, ["type", "displayName", "credentialRef", "confirmVerified"]);
      expect(form).toContain('pattern="env:[A-Z][A-Z0-9_]+"');
      expect(form).toContain("disabled={!isOwner}");
    });
  });
});
