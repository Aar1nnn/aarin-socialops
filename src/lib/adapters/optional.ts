export type AdapterStatus = "available" | "unconfigured" | "unsupported" | "failed";

export interface ImageGenerationAdapter {
  generate(input: { prompt: string; productAssetKeys: string[] }): Promise<{
    status: AdapterStatus;
    simulated: boolean;
    derivedAssetKey?: string;
    message?: string;
  }>;
}

export interface MetricsAdapter {
  fetch(input: { accountId: string; periodStart: Date; periodEnd: Date }): Promise<Array<{
    key: string;
    value: number | null;
    availability: "AVAILABLE" | "NOT_FETCHED" | "UNSUPPORTED" | "READ_FAILED";
    dataKind: "REAL" | "MOCK";
  }>>;
}

export interface InteractionReaderAdapter {
  read(input: { accountId: string; cursor?: string }): Promise<{
    status: AdapterStatus;
    records: unknown[];
    nextCursor?: string;
  }>;
}

export interface NotificationAdapter {
  send(input: { severity: "NORMAL" | "URGENT"; title: string; body: string }): Promise<{
    configured: boolean;
    delivered: boolean;
    deliveryId?: string;
    error?: string;
  }>;
}

export interface WordPressDraftAdapter {
  createDraft(input: { title: string; html: string; idempotencyKey: string }): Promise<{
    status: AdapterStatus;
    draftId?: string;
    draftUrl?: string;
    message?: string;
  }>;
}

export class UnconfiguredImageAdapter implements ImageGenerationAdapter {
  async generate() {
    return { status: "unconfigured" as const, simulated: false, message: "图片生成接口未配置；保留现有素材。" };
  }
}

export class UnconfiguredNotificationAdapter implements NotificationAdapter {
  async send() {
    return { configured: false, delivered: false, error: "外部通知通道未配置；必须创建站内待办。" };
  }
}

export class UnconfiguredWordPressAdapter implements WordPressDraftAdapter {
  async createDraft() {
    return { status: "unconfigured" as const, message: "WordPress 尚未连接，未写入任何外部内容。" };
  }
}
