export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

type StatusPresentation = {
  label: string;
  tone: StatusTone;
};

const STATUS_PRESENTATIONS: Record<string, StatusPresentation> = {
  DEMO: { label: "演示", tone: "warning" },
  DRAFT: { label: "草稿", tone: "neutral" },
  LIVE: { label: "正式", tone: "success" },
  OWNER: { label: "所有者", tone: "neutral" },
  OPERATOR: { label: "运营者", tone: "neutral" },
  VIEWER: { label: "只读成员", tone: "neutral" },
  CONFIRMED: { label: "已确认", tone: "success" },
  PROPOSED: { label: "待确认", tone: "warning" },
  MISSING: { label: "缺失", tone: "danger" },
  IMAGE: { label: "图片", tone: "neutral" },
  VIDEO: { label: "视频", tone: "neutral" },
  DOCUMENT: { label: "文档", tone: "neutral" },
  ORIGINAL: { label: "原始素材", tone: "neutral" },
  DERIVED: { label: "衍生素材", tone: "neutral" },
  UNCONFIGURED: { label: "未配置", tone: "neutral" },
  UNVERIFIED: { label: "未验证", tone: "warning" },
  VERIFIED: { label: "可用", tone: "success" },
  UNSUPPORTED: { label: "不支持", tone: "neutral" },
  REVIEW_PENDING: { label: "待人工审核", tone: "info" },
  APPROVED: { label: "已批准", tone: "success" },
  REJECTED: { label: "已拒绝", tone: "danger" },
  CHANGES_REQUESTED: { label: "需修改", tone: "warning" },
  SCHEDULED: { label: "已排期", tone: "info" },
  RUNNING: { label: "发布中", tone: "info" },
  PUBLISHED: { label: "已发布", tone: "success" },
  WAITING_CONFIGURATION: { label: "待配置", tone: "warning" },
  FAILED: { label: "失败", tone: "danger" },
  UNKNOWN: { label: "结果待确认", tone: "warning" },
  CANCELLED: { label: "已取消", tone: "neutral" },
  PENDING: { label: "等待处理", tone: "neutral" },
  MANUAL_PENDING: { label: "待人工发布", tone: "warning" },
  RETRY: { label: "等待重试", tone: "warning" },
  DISPATCHING: { label: "正在发送", tone: "info" },
  SUCCEEDED: { label: "已成功", tone: "success" },
  CONNECTING: { label: "连接中", tone: "info" },
  CONNECTED: { label: "已连接", tone: "success" },
  TOKEN_EXPIRING: { label: "凭据即将到期", tone: "warning" },
  TOKEN_EXPIRED: { label: "凭据已过期", tone: "danger" },
  PERMISSION_MISSING: { label: "权限不足", tone: "danger" },
  REVIEW_REQUIRED: { label: "需要复核", tone: "warning" },
  DISCONNECTED: { label: "未连接", tone: "neutral" },
  ERROR: { label: "连接异常", tone: "danger" },
  VALID: { label: "有效", tone: "success" },
  EXPIRING: { label: "即将到期", tone: "warning" },
  EXPIRED: { label: "已过期", tone: "danger" },
  REVOKED: { label: "已撤销", tone: "danger" },
  AVAILABLE: { label: "可用", tone: "success" },
  NOT_FETCHED: { label: "未同步", tone: "neutral" },
  PERMISSION_DENIED: { label: "权限不足", tone: "danger" },
  READ_FAILED: { label: "同步失败", tone: "danger" },
  REAL: { label: "真实数据", tone: "success" },
  MOCK: { label: "模拟数据", tone: "warning" },
  LOW: { label: "低", tone: "neutral" },
  NORMAL: { label: "普通", tone: "neutral" },
  HIGH: { label: "高", tone: "warning" },
  URGENT: { label: "紧急", tone: "danger" },
  NEW: { label: "新线索", tone: "info" },
  REPLIED: { label: "已回复", tone: "success" },
  HANDED_OFF: { label: "已转交", tone: "success" },
  WAITING_FEEDBACK: { label: "等待反馈", tone: "warning" },
  CLOSED: { label: "已关闭", tone: "neutral" },
  DISMISSED: { label: "已排除", tone: "neutral" },
  TODO: { label: "待处理", tone: "neutral" },
  IN_PROGRESS: { label: "处理中", tone: "info" },
  WAITING_EXTERNAL: { label: "等待外部反馈", tone: "warning" },
  COMPLETED: { label: "已完成", tone: "success" },
  PROCUREMENT: { label: "采购意向", tone: "info" },
  WHOLESALE: { label: "批发咨询", tone: "info" },
  INQUIRY: { label: "一般询盘", tone: "info" },
  CATALOG_REQUEST: { label: "索取目录", tone: "info" },
  SUPPLY_REQUEST: { label: "供货咨询", tone: "info" },
  GENERAL: { label: "一般互动", tone: "neutral" },
  SPAM: { label: "无效信息", tone: "neutral" },
  SIMULATED: { label: "模拟", tone: "warning" },
  FACEBOOK_PAGE: { label: "Facebook Page", tone: "neutral" },
  INSTAGRAM_PROFESSIONAL: { label: "Instagram 专业账号", tone: "neutral" },
  COMMENT: { label: "评论", tone: "neutral" },
  MESSAGE: { label: "私信", tone: "neutral" },
  MANUAL_NOTE: { label: "人工记录", tone: "neutral" },
  TEXT_GENERATION: { label: "文本生成", tone: "neutral" },
  IMAGE_GENERATION: { label: "图像生成", tone: "neutral" },
  SOCIAL_PUBLISHING: { label: "社媒发布", tone: "neutral" },
  METRICS: { label: "指标同步", tone: "neutral" },
  INTERACTIONS: { label: "互动同步", tone: "neutral" },
  NOTIFICATION: { label: "通知", tone: "neutral" },
  WORDPRESS: { label: "WordPress", tone: "neutral" },
  OBJECT_STORAGE: { label: "对象存储", tone: "neutral" },
  IN_APP: { label: "站内通知", tone: "neutral" },
  URGENT_EXTERNAL: { label: "紧急外部通知", tone: "warning" },
};

export function getStatusPresentation(value: string | null | undefined): StatusPresentation {
  if (!value) return { label: "未设置", tone: "neutral" };
  return STATUS_PRESENTATIONS[value] ?? {
    label: value
      .toLowerCase()
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    tone: "neutral",
  };
}

export function statusLabel(value: string | null | undefined) {
  return getStatusPresentation(value).label;
}

export function statusTone(value: string | null | undefined) {
  return getStatusPresentation(value).tone;
}

export function platformLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    facebook: "Facebook",
    FACEBOOK: "Facebook",
    instagram: "Instagram",
    INSTAGRAM: "Instagram",
    linkedin: "LinkedIn",
    LINKEDIN: "LinkedIn",
    youtube: "YouTube",
    YOUTUBE: "YouTube",
    tiktok: "TikTok",
    TIKTOK: "TikTok",
    META: "Meta",
  };
  return value ? labels[value] ?? value : "未设置";
}

export function formatDateTime(
  value: Date | string | null | undefined,
  fallback = "—",
  timeZone?: string,
) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}
