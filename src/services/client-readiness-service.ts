import { ClientMode, ContentStatus, PublishJobStatus } from "@prisma/client";
import type { RequestContext } from "../lib/context";
import { assessAssetExternalRead } from "../lib/adapters/storage";
import { db } from "../lib/db";
import { resolveAccountPublishingMode } from "../lib/manual-account";
import { getPlatformRegistry, resolveLivePublishingTarget } from "./platform-registry-service";

export type ReadinessStatus = "READY" | "ATTENTION" | "BLOCKED" | "NOT_APPLICABLE";

export type ReadinessCheck = {
  key: string;
  title: string;
  status: ReadinessStatus;
  detail: string;
  nextAction: string | null;
  nextHref: string | null;
};

export type AccountReadiness = {
  id: string;
  displayName: string;
  platform: string;
  mode: "API" | "MANUAL";
  publishing: ReadinessCheck;
  media: ReadinessCheck;
  metrics: ReadinessCheck;
  interactions: ReadinessCheck;
  unresolvedManualJobs: number;
  unresolvedApiJobs: number;
};

export type ClientReadiness = {
  client: { name: string; mode: ClientMode; timezone: string };
  assessedAt: Date;
  foundations: ReadinessCheck[];
  content: ReadinessCheck[];
  publishing: ReadinessCheck[];
  followUp: ReadinessCheck[];
  accounts: AccountReadiness[];
  products: Array<{ id: string; name: string; confirmedFactCount: number; status: ReadinessStatus }>;
};

function check(
  key: string,
  title: string,
  status: ReadinessStatus,
  detail: string,
  nextAction: string | null = null,
  nextHref: string | null = null,
): ReadinessCheck {
  return { key, title, status, detail, nextAction, nextHref };
}

const actionableContentStatuses = [
  ContentStatus.DRAFT,
  ContentStatus.CHANGES_REQUESTED,
  ContentStatus.REVIEW_PENDING,
  ContentStatus.APPROVED,
  ContentStatus.SCHEDULED,
  ContentStatus.WAITING_CONFIGURATION,
] as const;

const unresolvedJobStatuses = [PublishJobStatus.UNKNOWN, PublishJobStatus.WAITING_CONFIGURATION] as const;

/** A read-only, client-scoped projection of current capabilities and unresolved work. */
export async function getClientReadiness(context: RequestContext): Promise<ClientReadiness> {
  const assessedAt = new Date();
  const [client, strategy, products, accounts, prompt, textIntegration, mediaAssets, activeContent, unresolvedJobs, latestRealMetric, openLeadRows] = await Promise.all([
    db.client.findUniqueOrThrow({
      where: { id: context.clientId },
      select: { name: true, mode: true, timezone: true, targetMarkets: true, brandGuidelines: true, brandProfile: true },
    }),
    db.socialStrategy.findFirst({
      where: { clientId: context.clientId, status: "CONFIRMED" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { id: true, version: true },
    }),
    db.product.findMany({
      where: { clientId: context.clientId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, dataVersion: true, fields: { where: { clientId: context.clientId }, select: { status: true, value: true } } },
    }),
    db.socialAccount.findMany({
      where: { clientId: context.clientId },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }, { id: "asc" }],
      select: {
        id: true, platform: true, displayName: true, accountType: true, metadata: true,
        isSelected: true, externalAccountId: true,
        accessTokenCiphertext: true, accessTokenIv: true, accessTokenAuthTag: true, accessTokenExpiresAt: true,
        publishCapability: true, metricsCapability: true, commentsCapability: true,
        platformConnection: { select: { provider: true, status: true, accessTokenExpiresAt: true } },
        facebookConnection: { select: { connectionStatus: true, tokenStatus: true, tokenExpiresAt: true, pageId: true, credentialRef: true } },
      },
    }),
    db.promptVersion.findFirst({
      where: { clientId: context.clientId, capability: "multi_platform_content", active: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
    db.integrationConfig.findFirst({
      where: { clientId: context.clientId, type: "TEXT_GENERATION", status: "VERIFIED" },
      orderBy: [{ verifiedAt: "desc" }, { id: "desc" }],
      select: { provider: true },
    }),
    db.asset.findMany({
      where: { clientId: context.clientId, kind: { in: ["IMAGE", "VIDEO"] } },
      select: { kind: true, storageProvider: true, storageKey: true, metadata: true },
    }),
    db.contentItem.findMany({
      where: {
        clientId: context.clientId,
        status: { in: [...actionableContentStatuses] },
        plan: { is: { clientId: context.clientId } },
        account: { is: { clientId: context.clientId } },
        currentVersion: { is: { clientId: context.clientId } },
      },
      select: {
        id: true, status: true,
        plan: { select: { productId: true } },
        currentVersion: { select: { productDataVersion: true, source: true } },
      },
    }),
    db.publishJob.findMany({
      where: {
        clientId: context.clientId, status: { in: [...unresolvedJobStatuses] },
        account: { is: { clientId: context.clientId } },
        contentVersion: { is: { clientId: context.clientId } },
      },
      select: { id: true, accountId: true, adapter: true, status: true },
    }),
    db.metricSnapshot.findFirst({
      where: {
        clientId: context.clientId, dataKind: "REAL", availability: "AVAILABLE", numericValue: { not: null },
        account: { is: { clientId: context.clientId } },
      },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      select: { fetchedAt: true },
    }),
    db.lead.findMany({
      where: {
        clientId: context.clientId, handoffStatus: { in: ["NEW", "REPLIED", "HANDED_OFF", "WAITING_FEEDBACK"] },
        interaction: { is: { clientId: context.clientId } },
      },
      select: { handoffStatus: true },
    }),
  ]);

  const productRows = products.map((product) => {
    const confirmedFactCount = product.fields.filter((field) => field.status === "CONFIRMED" && Boolean(field.value)).length;
    return { id: product.id, name: product.name, confirmedFactCount, status: (confirmedFactCount ? "READY" : "BLOCKED") as ReadinessStatus };
  });
  const confirmedProductCount = productRows.filter((product) => product.status === "READY").length;
  // Mirror the current /content target picker. Generation still performs its own platform validation.
  const selectedAiAccountCount = accounts.filter((account) => account.isSelected && account.platform !== "youtube").length;
  const manualAccountCount = accounts.filter((account) => account.isSelected && resolveAccountPublishingMode(account) === "MANUAL").length;
  const hasBrandContext = Boolean(client.brandProfile && (
    client.brandProfile.businessSummary?.trim() || client.brandProfile.positioning?.trim()
    || client.brandProfile.audience?.trim() || client.brandProfile.tone?.trim()
    || client.brandProfile.voiceTraits.length || client.brandProfile.goals.length
  )) || Boolean(client.brandGuidelines?.trim());

  const foundations: ReadinessCheck[] = [
    check("brand", "长期品牌资料", hasBrandContext ? "READY" : "ATTENTION",
      hasBrandContext ? "已记录品牌上下文；产品事实与品牌硬规则仍由原有流程校验。" : "尚未记录结构化品牌资料或旧品牌说明；这不是人工内容的硬性门槛。",
      hasBrandContext ? null : "完善品牌资料", hasBrandContext ? null : "/brand"),
    check("target-markets", "企业默认目标市场", client.targetMarkets.length ? "READY" : "ATTENTION",
      client.targetMarkets.length
        ? `已记录 ${client.targetMarkets.length} 个企业默认市场；当前运营周期的市场选择仍由 SocialStrategy 表示。`
        : "尚未记录企业默认市场。此项提醒不替代策略市场，也不会阻断人工内容。",
      client.targetMarkets.length ? null : "查看客户设置", client.targetMarkets.length ? null : "/settings"),
    check("strategy", "当前运营策略", strategy ? "READY" : client.mode === "LIVE" ? "BLOCKED" : "ATTENTION",
      strategy ? `已确认运营策略 v${strategy.version}；仅新 AI 内容绑定当前确认版。` : client.mode === "LIVE"
        ? "LIVE 客户的新 AI 内容需要已确认的 SocialStrategy；历史内容的人工操作不受此限制。"
        : "未确认运营策略；DEMO / DRAFT 的 AI 生成会保留未确认或未绑定 provenance。",
      strategy ? null : "查看运营策略", strategy ? null : "/strategy"),
  ];

  const realModelConfigured = textIntegration?.provider === "openai-compatible";
  const modelCredentialsPresent = ["TEXT_MODEL_BASE_URL", "TEXT_MODEL_API_KEY", "TEXT_MODEL_NAME"]
    .every((name) => Boolean(process.env[name]?.trim()));
  const aiBlocker = confirmedProductCount === 0
    ? check("ai-content", "AI 内容完整工作流", "BLOCKED", "现有内容页面、AI 改写及非人工内容审核要求已确认 ProductField。人工内容创建不受此规则阻断。", "确认产品事实", "/products")
    : selectedAiAccountCount === 0
      ? check("ai-content", "AI 内容完整工作流", "BLOCKED", "尚无已选择且支持当前 AI 内容入口的平台账号。", "选择目标账号", "/accounts")
      : !prompt
        ? check("ai-content", "AI 内容完整工作流", "BLOCKED", "内容生成 PromptVersion 尚未配置。", "检查内容配置", "/settings")
        : client.mode === "LIVE" && !strategy
          ? check("ai-content", "AI 内容完整工作流", "BLOCKED", "LIVE 客户的新 AI 内容生成需要当前已确认 SocialStrategy。", "确认运营策略", "/strategy")
          : realModelConfigured && !modelCredentialsPresent
            ? check("ai-content", "AI 内容完整工作流", "BLOCKED", "已选择真实模型，但运行环境缺少模型地址、密钥或模型名称；调用时会返回 MODEL_CREDENTIALS_MISSING。", "检查模型配置", "/settings")
          : null;
  const aiContent = aiBlocker || check("ai-content", "AI 内容完整工作流",
    realModelConfigured && Boolean(strategy) ? "READY" : "ATTENTION",
    !realModelConfigured
      ? "现有生成流程将使用模拟模型；产品已确认事实与人工审核规则保持不变。"
      : !strategy
        ? "DEMO / DRAFT 可使用未确认策略预览或未绑定回退，并在版本中记录 provenance。"
        : "具备现有 AI 内容入口所需的产品事实、目标账号、Prompt 与策略条件；每条内容仍须通过审核。",
    !realModelConfigured ? "查看模型配置" : !strategy ? "查看运营策略" : "创建 AI 内容",
    !realModelConfigured ? "/settings" : !strategy ? "/strategy" : "/content?create=1#new-content");
  const manualContent = check("manual-content", "人工内容创建", manualAccountCount ? "READY" : "BLOCKED",
    manualAccountCount
      ? "已选择人工管理账号；允许不关联产品，也不要求当前策略或已确认产品事实。后续审核与发布仍按现有规则执行。"
      : "尚无已选择的人工管理账号；可先创建 LinkedIn、TikTok 或 YouTube 人工账号。",
    manualAccountCount ? "创建人工内容" : "创建人工账号",
    manualAccountCount ? "/content?manual=1#manual-content" : "/accounts#manual-account");
  const productVersions = new Map(products.map((product) => [product.id, product.dataVersion]));
  const staleContentCount = activeContent.filter((item) => item.plan.productId
    && item.currentVersion?.productDataVersion !== productVersions.get(item.plan.productId)).length;
  const pendingReviewCount = activeContent.filter((item) => item.status === "REVIEW_PENDING").length;
  const content: ReadinessCheck[] = [
    aiContent,
    manualContent,
    check("stale-content", "当前内容与产品资料", staleContentCount ? "BLOCKED" : "READY",
      staleContentCount
        ? `${staleContentCount} 条当前可处理内容的产品资料版本已变化；历史已发布或已取消内容不计入当前阻碍。`
        : "当前可处理内容没有检测到产品资料版本过期；历史终态内容保持原事实快照。",
      staleContentCount ? "处理当前内容" : null, staleContentCount ? "/content" : null),
    check("review-queue", "待人工审核", pendingReviewCount ? "ATTENTION" : "READY",
      pendingReviewCount ? `${pendingReviewCount} 条当前内容等待人工审核。` : "当前没有等待人工审核的内容。",
      pendingReviewCount ? "处理审核" : null, pendingReviewCount ? "/content?status=review#content-list" : null),
  ];

  const unknownJobs = unresolvedJobs.filter((job) => job.status === "UNKNOWN");
  const waitingJobs = unresolvedJobs.filter((job) => job.status === "WAITING_CONFIGURATION");
  const publishing: ReadinessCheck[] = [
    check("unknown-jobs", "结果待核实的发布任务", unknownJobs.length ? "BLOCKED" : "READY",
      unknownJobs.length
        ? `${unknownJobs.length} 个当前 UNKNOWN 任务需要先核实外部事实；人工与 API 任务按各自已有对账流程处理，禁止直接重试。`
        : "当前没有结果不确定的发布任务。",
      unknownJobs.length ? "前往发布中心对账" : null, unknownJobs.length ? "/publishing?status=UNKNOWN" : null),
    check("waiting-configuration", "等待配置的发布任务", waitingJobs.length ? "ATTENTION" : "READY",
      waitingJobs.length
        ? `${waitingJobs.length} 个当前 WAITING_CONFIGURATION 任务仍需修复连接或能力；本阶段没有恢复执行入口。`
        : "当前没有等待配置的发布任务。",
      waitingJobs.length ? "查看原因与下一步" : null, waitingJobs.length ? "/publishing?status=WAITING_CONFIGURATION" : null),
  ];

  const realMetricFresh = latestRealMetric
    && assessedAt.getTime() - latestRealMetric.fetchedAt.getTime() <= 24 * 60 * 60 * 1000;
  const pendingLeadCount = openLeadRows.filter((lead) => lead.handoffStatus === "NEW" || lead.handoffStatus === "WAITING_FEEDBACK").length;
  const ongoingLeadCount = openLeadRows.length - pendingLeadCount;
  const followUp: ReadinessCheck[] = [
    check("analytics-review", "Analytics Review", realMetricFresh ? "READY" : "ATTENTION",
      !latestRealMetric
        ? "当前没有可用 REAL 指标快照；缺失不能解释为 0，也不会阻断内容或发布运营。"
        : realMetricFresh
          ? "存在近 24 小时采集的可用 REAL 指标；数据新鲜度不表示表现好坏，复盘仍需检查覆盖范围。"
          : "最近可用 REAL 指标已超过 24 小时；可继续运营，但复盘需要标明数据过期。",
      "查看指标与数据范围", "/analytics"),
    check("lead-handoff", "Lead Handoff", openLeadRows.length ? "ATTENTION" : "READY",
      openLeadRows.length
        ? `当前线索记录中 ${pendingLeadCount} 条处于 NEW / WAITING_FEEDBACK，${ongoingLeadCount} 条处于 REPLIED / HANDED_OFF；这些是交接状态，不代表商机质量。`
        : "当前没有待处理交接线索；没有 Lead 记录不是运营阻断，也不代表有合格线索。",
      openLeadRows.length ? "处理线索" : null, openLeadRows.length ? "/insights#leads" : null),
  ];

  const registry = getPlatformRegistry();
  const accountRows: AccountReadiness[] = accounts.map((account) => {
    const mode = resolveAccountPublishingMode(account);
    const definition = registry.getByPlatform(account.platform)?.definition;
    const relatedJobs = unresolvedJobs.filter((job) => job.accountId === account.id);
    const unresolvedManualJobs = relatedJobs.filter((job) => job.adapter === "manual").length;
    const unresolvedApiJobs = relatedJobs.length - unresolvedManualJobs;
    const prefix = `account:${account.id}`;
    const oauthConnectionReady = account.isSelected
      && account.platformConnection?.provider === definition?.provider
      && account.platformConnection?.status === "CONNECTED"
      && Boolean(account.externalAccountId && account.accessTokenCiphertext && account.accessTokenIv && account.accessTokenAuthTag);
    const legacyFacebookReady = account.platform === "facebook"
      && account.facebookConnection?.connectionStatus === "VERIFIED"
      && account.facebookConnection.tokenStatus === "VALID"
      && account.publishCapability === "VERIFIED"
      && Boolean(account.facebookConnection.credentialRef);
    const connectionReady = oauthConnectionReady || legacyFacebookReady;
    const tokenExpired = Boolean(
      (account.accessTokenExpiresAt && account.accessTokenExpiresAt <= assessedAt)
      || (account.platformConnection?.accessTokenExpiresAt && account.platformConnection.accessTokenExpiresAt <= assessedAt)
      || (account.facebookConnection?.tokenExpiresAt && account.facebookConnection.tokenExpiresAt <= assessedAt),
    );
    const media = definition?.media;
    const compatibleAssets = mediaAssets.filter((asset) => media?.kinds.includes(asset.kind as "IMAGE" | "VIDEO"));
    const externalCandidateCount = media?.requiresPublicHttpsUrl
      ? compatibleAssets.filter((asset) => assessAssetExternalRead(asset, { now: assessedAt }).ready).length
      : 0;
    const mediaCheck = !media || !media.required
      ? check(`${prefix}:media`, "发布素材", "NOT_APPLICABLE", "平台允许纯文字或无强制素材；单条内容的格式仍按原有校验执行。")
      : compatibleAssets.length === 0
        ? check(`${prefix}:media`, "发布素材", "ATTENTION", "当前素材库没有此平台要求的图片或视频类型；只影响该平台的内容准备。", "查看素材库", "/assets")
        : media.requiresPublicHttpsUrl && externalCandidateCount === 0
          ? check(`${prefix}:media`, "发布素材", "ATTENTION", "有兼容素材，但本地元数据没有可验证的公开 HTTPS 候选；远端存储可能在发布时签发地址，仍须逐条验证。", "检查素材可用性", "/assets")
          : check(`${prefix}:media`, "发布素材", media.requiresPublicHttpsUrl ? "ATTENTION" : "READY",
            media.requiresPublicHttpsUrl
              ? `有 ${externalCandidateCount} 个本地可判定的 HTTPS 候选；外部平台能否读取仍未验收，单条内容必须重新校验。`
              : `有 ${compatibleAssets.length} 个兼容素材；单条内容仍须检查数量、格式与批准。`,
            "查看素材库", "/assets");
    let publishingCheck: ReadinessCheck;
    if (mode === "MANUAL") {
      publishingCheck = client.mode !== "LIVE"
        ? check(`${prefix}:publishing`, "人工发布", "BLOCKED", "人工内容可继续创建与审核；只有 LIVE 客户可以开始新的真实人工发布。", "查看客户模式", "/settings")
        : !account.isSelected
          ? check(`${prefix}:publishing`, "人工发布", "BLOCKED", "此人工账号未被选入当前运营范围。", "查看账号", "/accounts")
          : !definition
            ? check(`${prefix}:publishing`, "人工发布", "BLOCKED", "平台未在当前 Registry 中定义。", "查看账号", "/accounts")
            : media?.required && compatibleAssets.length === 0
              ? check(`${prefix}:publishing`, "人工发布", "ATTENTION", "此平台的人工发布要求视频素材，当前素材库没有视频；人工内容创建仍可进行。", "上传视频素材", "/assets#upload-asset")
              : check(`${prefix}:publishing`, "人工发布", "READY", "可走人工操作与证据回填流程；这不表示平台 API 已接通，单条内容仍需有效批准与合适素材。", "创建人工内容", "/content?manual=1#manual-content");
    } else {
      const liveTarget = resolveLivePublishingTarget({
        platform: account.platform, accountType: account.accountType,
        isSelected: account.isSelected, publishCapability: account.publishCapability,
        externalAccountId: account.externalAccountId,
        hasEncryptedAccessToken: Boolean(account.accessTokenCiphertext && account.accessTokenIv && account.accessTokenAuthTag),
        connection: account.platformConnection ? { provider: account.platformConnection.provider, status: account.platformConnection.status } : null,
        legacyFacebook: account.facebookConnection ? {
          connectionStatus: account.facebookConnection.connectionStatus,
          tokenStatus: account.facebookConnection.tokenStatus,
          pageId: account.facebookConnection.pageId,
        } : null,
      });
      publishingCheck = client.mode !== "LIVE"
        ? check(`${prefix}:publishing`, "API 真实发布", "BLOCKED", "当前客户不是 LIVE；DEMO 的模拟任务不代表真实 API 发布能力。", "查看客户模式", "/settings")
        : definition?.externalVerification === "NOT_IMPLEMENTED" || !definition?.capabilities.includes("PUBLISH")
          ? check(`${prefix}:publishing`, "API 真实发布", "BLOCKED", "Registry 未实现此平台的真实 API 发布能力。", "查看账号", "/accounts")
          : !liveTarget || tokenExpired
            ? check(`${prefix}:publishing`, "API 真实发布", "BLOCKED", tokenExpired
              ? "已知账号或连接凭据到期；需要重新授权。"
              : "账号选择、发布能力、外部账号或连接凭据未满足现有 LIVE 排期校验。",
              "检查连接与能力", "/connections")
            : definition.externalVerification !== "VERIFIED"
              ? check(`${prefix}:publishing`, "API 真实发布", "ATTENTION",
                `Registry 标记为 IMPLEMENTED_NOT_EXTERNALLY_VERIFIED；可用性受限，不能视为已外部验收的真实 API 发布。${media?.requiresPublicHttpsUrl ? externalCandidateCount ? "存在本地 HTTPS 候选，外部读取仍未验收。" : "当前无本地可判定的公开 HTTPS 素材候选。" : ""}`,
                "查看平台限制", "/accounts")
              : check(`${prefix}:publishing`, "API 真实发布", "READY",
                "Registry 已外部验证，账号满足当前 LIVE adapter 选择条件；单条内容仍需批准、素材与排期校验。",
                "进入内容中心", "/content");
    }

    function dataCapability(kind: "METRICS" | "COMMENTS", capability: typeof account.metricsCapability): ReadinessCheck {
      const title = kind === "METRICS" ? "API 指标" : "API 互动";
      const key = `${prefix}:${kind.toLowerCase()}`;
      if (mode === "MANUAL") return check(key, title, "NOT_APPLICABLE", "人工管理账号不提供此项平台 API 能力；这不影响人工内容或人工发布。", null, null);
      if (!definition?.capabilities.includes(kind)) return check(key, title, "BLOCKED", "Registry 未实现此平台的对应 API 能力。", "查看账号", "/accounts");
      if (capability === "UNSUPPORTED") return check(key, title, "BLOCKED", "账号明确标记不支持此项 API 能力。", "查看账号", "/accounts");
      if (capability !== "VERIFIED" || !connectionReady || tokenExpired) return check(key, title, "ATTENTION", "账号能力、连接或授权尚未同时满足已验证状态；指标和互动分别核验。", "检查连接与能力", "/connections");
      return check(key, title, "READY", "账号与连接的对应能力已验证；数据覆盖与新鲜度仍以实际同步记录为准。", null, null);
    }

    return {
      id: account.id, displayName: account.displayName, platform: account.platform, mode,
      publishing: publishingCheck, media: mediaCheck,
      metrics: dataCapability("METRICS", account.metricsCapability),
      interactions: dataCapability("COMMENTS", account.commentsCapability),
      unresolvedManualJobs, unresolvedApiJobs,
    };
  });

  return {
    client: { name: client.name, mode: client.mode, timezone: client.timezone }, assessedAt,
    foundations, content, publishing, followUp, accounts: accountRows, products: productRows,
  };
}
