"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Notice } from "@/components/ui";

export function AccountSelectionForm({ connectionId, children }: { connectionId: string; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const action = `/api/connections/${connectionId}/select-accounts`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    try {
      const response = await fetch(action, {
        method: "POST",
        body: new FormData(event.currentTarget),
        headers: { Accept: "application/json" },
      });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) {
        setError(result.error === "ACCOUNT_SELECTION_CONFLICT"
          ? "账号选择已被其他人更新。请刷新页面，核对当前选择后重试。"
          : result.message || "保存失败，请刷新页面后重试。");
        return;
      }
      window.location.reload();
    } catch {
      setError("无法保存账号选择，请检查连接并刷新页面后重试。");
    } finally {
      submitting.current = false;
    }
  }

  return <form action={action} method="post" className="stack" onSubmit={submit}>
    {children}
    {error ? <Notice title="保存失败" tone="warning">
      <p>{error}</p>
      <button type="button" className="button button-secondary button-sm" onClick={() => window.location.reload()}>刷新页面</button>
    </Notice> : null}
  </form>;
}
