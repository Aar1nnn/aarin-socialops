import { LeadCategory, LeadPriority, Prisma } from "@prisma/client";
import { db } from "../lib/db";
import { interactionImportSchema } from "../lib/contracts";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";

const intentRules: Array<{ category: LeadCategory; priority: LeadPriority; words: RegExp; reason: string }> = [
  { category: "CATALOG_REQUEST", priority: "HIGH", words: /\b(catalog(?:ue)?|price list|产品目录|目录)\b/i, reason: "明确索取目录或价格表" },
  { category: "WHOLESALE", priority: "HIGH", words: /\b(wholesale|wholesaler|distributor|dealer|批发|经销商|代理)\b/i, reason: "明确提及批发、经销或代理" },
  { category: "PROCUREMENT", priority: "HIGH", words: /\b(procure(?:ment)?|purchase order|bulk order|MOQ|采购|大货|起订量)\b/i, reason: "明确提及采购、批量订单或 MOQ" },
  { category: "SUPPLY_REQUEST", priority: "HIGH", words: /\b(supply|supplier|lead time|供货|供应|交期)\b/i, reason: "明确询问供货或交期" },
  { category: "INQUIRY", priority: "NORMAL", words: /\b(quote|quotation|price|how much|inquiry|enquiry|询价|报价|多少钱)\b/i, reason: "明确询价或要求报价" },
];

export function classifyIntent(body: string): {
  category: LeadCategory;
  priority: LeadPriority;
  rationale: string;
  isLead: boolean;
} {
  const normalized = body.trim();
  if (!normalized || /^(like|liked|nice|great|cool|love it|赞|好看|不错|👍|❤️|🔥|👏)[!！.。\s]*$/iu.test(normalized)) {
    return { category: "GENERAL", priority: "LOW", rationale: "仅点赞、表情或泛泛评论，不构成有效采购意向", isLead: false };
  }
  for (const rule of intentRules) {
    if (rule.words.test(normalized)) {
      return { category: rule.category, priority: rule.priority, rationale: rule.reason, isLead: true };
    }
  }
  return { category: "GENERAL", priority: "LOW", rationale: "未发现采购、批发、询价、目录或供货等明确意向", isLead: false };
}

export async function importInteraction(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = interactionImportSchema.parse(raw);
  if (input.accountId) {
    const account = await db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId } });
    if (!account) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  }
  const classification = classifyIntent(input.body);
  try {
    const created = await db.$transaction(async (tx) => {
      const interaction = await tx.interaction.create({
        data: {
          clientId: context.clientId,
          accountId: input.accountId,
          platform: input.platform,
          platformRecordId: input.platformRecordId,
          interactionType: input.interactionType,
          authorHandle: input.authorHandle,
          authorDisplay: input.authorDisplay,
          body: input.body,
          sourceUrl: input.sourceUrl || null,
          occurredAt: input.occurredAt,
          rawPayload: { importedManually: true },
        },
      });
      const lead = classification.isLead ? await createLeadBundle(tx, context.clientId, interaction, classification) : null;
      await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "INTERACTION_IMPORTED", entityType: "Interaction", entityId: interaction.id, metadata: { isLead: classification.isLead, platform: input.platform } } });
      return { interaction, lead };
    });
    return { ...created, classification, duplicated: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const interaction = await db.interaction.findUniqueOrThrow({ where: { clientId_platform_platformRecordId: { clientId: context.clientId, platform: input.platform, platformRecordId: input.platformRecordId } }, include: { lead: true } });
      let lead = interaction.lead;
      if (classification.isLead && !lead) {
        try {
          lead = await db.$transaction((tx) => createLeadBundle(tx, context.clientId, interaction, classification));
        } catch (backfillError) {
          if (!(backfillError instanceof Prisma.PrismaClientKnownRequestError && backfillError.code === "P2002")) throw backfillError;
          lead = await db.lead.findUnique({ where: { interactionId: interaction.id } });
        }
      }
      return { interaction, classification, lead, duplicated: true };
    }
    throw error;
  }
}

export async function updateLeadStatus(context: RequestContext, leadId: string, status: string, feedback?: string) {
  assertCanWrite(context);
  const allowed = ["NEW", "REPLIED", "HANDED_OFF", "WAITING_FEEDBACK", "CLOSED", "DISMISSED"] as const;
  if (!allowed.includes(status as (typeof allowed)[number])) throw new AppError("线索状态无效。", 400, "INVALID_LEAD_STATUS");
  const lead = await db.lead.findFirst({ where: { id: leadId, clientId: context.clientId } });
  if (!lead) throw new AppError("线索不存在或无权访问。", 404, "LEAD_NOT_FOUND");
  return db.$transaction(async (tx) => {
    const updated = await tx.lead.update({ where: { id: lead.id }, data: { handoffStatus: status as (typeof allowed)[number], salesFeedback: feedback || undefined } });
    if (status !== "NEW") await tx.manualTask.updateMany({ where: { clientId: context.clientId, leadId: lead.id, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } }, data: { status: status === "WAITING_FEEDBACK" ? "WAITING_EXTERNAL" : "COMPLETED", completedAt: status === "WAITING_FEEDBACK" ? null : new Date() } });
    await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "LEAD_STATUS_UPDATED", entityType: "Lead", entityId: lead.id, metadata: { status, feedbackProvided: Boolean(feedback) } } });
    return updated;
  });
}

async function createLeadBundle(
  tx: Prisma.TransactionClient,
  clientId: string,
  interaction: { id: string; body: string; platform: string; sourceUrl: string | null; authorHandle: string | null },
  classification: ReturnType<typeof classifyIntent>,
) {
  const lead = await tx.lead.create({ data: { clientId, interactionId: interaction.id, category: classification.category, priority: classification.priority, rationale: classification.rationale, verificationNeeded: "跨平台身份未经验证；不得按相似用户名自动合并。" } });
  await tx.manualTask.create({ data: { clientId, leadId: lead.id, triggerReason: "发现明确采购相关意向", priority: classification.priority === "HIGH" || classification.priority === "URGENT" ? "URGENT" : "HIGH", suggestedDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000), sourceMaterial: { originalText: interaction.body, platform: interaction.platform, sourceUrl: interaction.sourceUrl, authorHandle: interaction.authorHandle }, requiredAction: "人工核实意向、准备回复，并按需转交吕总；系统不会自动发送任何回复。", completionCriteria: "线索状态记录为已回复、已转交、等待反馈或已关闭。", continuationStep: "结合销售反馈更新线索状态并纳入复盘。" } });
  await tx.inAppNotification.create({ data: { clientId, severity: "URGENT", title: "发现重要采购意向", body: `${classification.rationale}：${interaction.body.slice(0, 160)}`, relatedType: "Lead", relatedId: lead.id } });
  return lead;
}
