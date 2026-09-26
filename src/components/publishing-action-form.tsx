"use client";

import { useState, type FormEvent, type ReactNode } from "react";

export function PublishingActionForm({ action, children, className = "form-stack" }: {
  action: string;
  children: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      const response = await fetch(action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setProblem(typeof result.message === "string" ? result.message : "操作失败，请刷新后重试。");
        return;
      }
      window.location.reload();
    } catch {
      setProblem("连接失败，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  return <form action={action} onSubmit={submit} className={className} aria-busy={busy}>
    {children}
    {problem ? <p role="alert">{problem}</p> : null}
  </form>;
}
