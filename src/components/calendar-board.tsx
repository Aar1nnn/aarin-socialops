"use client";

import { useMemo, useState } from "react";
import { calendarDateKey, moveCalendarDatePreservingClock } from "../lib/calendar-display";

type Entry = {
  id: string;
  platform: string;
  accountName: string;
  theme: string;
  title: string | null;
  status: string;
  scheduledAt: string | null;
  approvalStatus: string | null;
  publishJobStatus: string | null;
  publishingMode: "MANUAL" | "API";
  reschedulable: boolean;
  lockReason: string | null;
};

export function CalendarBoard({ entries, view, startDate, dayCount, timezone, readOnly }: {
  entries: Entry[];
  view: "month" | "week" | "list";
  startDate: string;
  dayCount: number;
  timezone: string;
  readOnly: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const days = useMemo(() => {
    const start = new Date(`${startDate}T00:00:00Z`);
    return Array.from({ length: dayCount }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      return date;
    });
  }, [startDate, dayCount]);

  async function move(contentItemId: string, targetDate: string) {
    const entry = entries.find((candidate) => candidate.id === contentItemId);
    if (pending || readOnly || !entry?.reschedulable || !entry.scheduledAt) return;
    setPending(true);
    setProblem("");
    try {
      const localDateTime = moveCalendarDatePreservingClock(entry.scheduledAt, targetDate, timezone);
      const response = await fetch("/api/calendar/reschedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentItemIds: [contentItemId], localDateTime, timezone }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({ message: "重排失败" }));
        setProblem(result.message || "重排失败");
        return;
      }
      window.location.reload();
    } finally {
      setPending(false);
    }
  }

  function entryContent(entry: Entry) {
    return <>
      <strong>{entry.title || entry.theme}</strong>
      <small className="cell-meta">{entry.platform.toUpperCase()} · {entry.accountName} · {entry.publishingMode === "MANUAL" ? "人工发布" : "API/模拟发布"}</small>
      <small className="cell-meta">内容：{entry.status} · 批准：{entry.approvalStatus || "无"} · 任务：{entry.publishJobStatus || "无"}</small>
      <small className="cell-meta">{entry.scheduledAt ? new Date(entry.scheduledAt).toLocaleString("zh-CN", { timeZone: timezone }) : "未排期"} · {timezone}</small>
      {entry.lockReason ? <small className="cell-meta">不可拖动：{entry.lockReason}</small> : null}
      <span className="row"><a className="text-link" href={`/content/${entry.id}`}>查看内容</a><a className="text-link" href="/publishing">发布中心</a></span>
    </>;
  }

  return <div aria-busy={pending}>
    {problem ? <p role="alert" className="field-helper">重排失败：{problem}。请检查目标账号附近排期和当前任务状态。</p> : null}
    {view === "list" ? <div className="list">{entries.map((entry) => <article key={entry.id} className="list-item">{entryContent(entry)}</article>)}</div>
      : <div className="calendar-board">{days.map((day) => {
        const key = day.toISOString().slice(0, 10);
        const dayEntries = entries.filter((entry) => calendarDateKey(entry.scheduledAt, timezone) === key);
        return <section className="calendar-day" key={key} onDragOver={(event) => { if (!readOnly) event.preventDefault(); }} onDrop={(event) => {
          const id = event.dataTransfer.getData("text/content-item-id");
          if (id) void move(id, key);
        }}>
          <strong>{day.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: "UTC" })}</strong>
          {dayEntries.map((entry) => <article key={entry.id} className="calendar-entry" draggable={!readOnly && entry.reschedulable} onDragStart={(event) => event.dataTransfer.setData("text/content-item-id", entry.id)}>{entryContent(entry)}</article>)}
        </section>;
      })}</div>}
  </div>;
}
