"use client";

import { useMemo, useState } from "react";

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
  reschedulable: boolean;
};

function dateKey(value: Date | string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "unscheduled";
}
export function CalendarBoard({ entries, view, startDate }: { entries: Entry[]; view: "month" | "week" | "list"; startDate: string }) {
  const [pending, setPending] = useState(false);
  const days = useMemo(() => {
    const start = new Date(`${startDate}T00:00:00Z`);
    const count = view === "week" ? 7 : view === "month" ? 35 : 0;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      return date;
    });
  }, [startDate, view]);

  async function move(contentItemId: string, date: Date) {
    if (pending) return;
    setPending(true);
    date.setUTCHours(9, 0, 0, 0);
    const response = await fetch("/api/calendar/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentItemIds: [contentItemId], scheduledAt: date.toISOString() }),
    });
    setPending(false);
    if (!response.ok) {
      const result = await response.json().catch(() => ({ message: "重排失败" }));
      window.alert(result.message || "重排失败");
      return;
    }
    window.location.reload();
  }

  if (view === "list") return <div className="list">{entries.map((entry) => <article key={entry.id} className="list-item row">
    <div><strong>{entry.title || entry.theme}</strong><br /><small className="muted">{entry.platform} · {entry.accountName} · {entry.scheduledAt ? new Date(entry.scheduledAt).toLocaleString("zh-CN") : "未排期"}</small></div>
    <span className="badge">{entry.status}</span>
  </article>)}</div>;

  return <div className="calendar-board" aria-busy={pending}>{days.map((day) => {
    const key = dateKey(day);
    const dayEntries = entries.filter((entry) => dateKey(entry.scheduledAt) === key);
    return <section className="calendar-day" key={key} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      const id = event.dataTransfer.getData("text/content-item-id");
      if (id) void move(id, new Date(day));
    }}>
      <strong>{day.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</strong>
      {dayEntries.map((entry) => <article key={entry.id} className="calendar-entry" draggable={entry.reschedulable} onDragStart={(event) => event.dataTransfer.setData("text/content-item-id", entry.id)}>
        <b>{entry.platform.toUpperCase()}</b><br />{entry.title || entry.theme}<br /><small>{entry.status}</small>
      </article>)}
    </section>;
  })}</div>;
}
