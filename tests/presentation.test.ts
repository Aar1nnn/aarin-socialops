import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, FormField, StatusIndicator } from "../src/components/ui";
import { formatDateTime, getStatusPresentation, platformLabel, statusLabel } from "../src/lib/presentation/status";

describe("operator presentation", () => {
  it.each([
    ["REVIEW_PENDING", "待审核"],
    ["WAITING_CONFIGURATION", "待配置"],
    ["PERMISSION_MISSING", "权限不足"],
    ["CATALOG_REQUEST", "索取目录"],
    ["WAITING_EXTERNAL", "等待外部反馈"],
    ["PUBLISHED", "已发布"],
    ["UNKNOWN", "待确认"],
    ["LIVE", "正式"],
    ["DEMO", "演示"],
    ["READ_FAILED", "同步失败"],
    ["INSTAGRAM_PROFESSIONAL", "Instagram 专业账号"],
  ])("maps %s to business-readable copy", (value, expected) => {
    expect(statusLabel(value)).toBe(expected);
  });

  it("assigns semantic tones without relying on the raw value", () => {
    expect(getStatusPresentation("CONNECTED").tone).toBe("success");
    expect(getStatusPresentation("UNKNOWN").tone).toBe("warning");
    expect(getStatusPresentation("FAILED").tone).toBe("danger");
  });

  it("normalizes supported platform names", () => {
    expect(platformLabel("facebook")).toBe("Facebook");
    expect(platformLabel("INSTAGRAM")).toBe("Instagram");
  });

  it("formats operational timestamps in the workspace timezone", () => {
    expect(formatDateTime("2026-01-01T00:00:00.000Z", "—", "Asia/Shanghai")).toContain("08:00");
  });

  it("renders status with text as well as a visual dot", () => {
    const markup = renderToStaticMarkup(createElement(StatusIndicator, { value: "CONNECTED" }));
    expect(markup).toContain("已连接");
    expect(markup).toContain("aria-hidden=\"true\"");
    expect(markup).not.toContain(">CONNECTED<");
  });

  it("renders a concise semantic empty state", () => {
    const markup = renderToStaticMarkup(createElement(EmptyState, {
      title: "还没有内容",
      description: "创建第一条内容后，即可进入审核和发布流程。",
    }));
    expect(markup).toContain("<h3>还没有内容</h3>");
    expect(markup).toContain("审核和发布流程");
  });

  it("associates helper text with the field control", () => {
    const markup = renderToStaticMarkup(createElement(
      FormField,
      {
        label: "计划发布时间",
        htmlFor: "publish-time",
        helper: "按工作区时区填写。",
        children: createElement("input", { id: "publish-time", name: "localDateTime" }),
      },
    ));
    expect(markup).toContain('aria-describedby="publish-time-helper"');
    expect(markup).toContain('id="publish-time-helper"');
  });
});
