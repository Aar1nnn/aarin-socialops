import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { zonedLocalDateTimeToUtc } from "@/lib/timezone";
import { listCalendarEntries } from "@/services/calendar-service";

type Search = Record<string, string | string[] | undefined>;

function value(search: Search, key: string) {
  const candidate = search[key];
  return Array.isArray(candidate) ? candidate[0] : candidate;
}

function dateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addLocalDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDateInput(candidate: string | undefined) {
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? undefined : candidate;
}

function rangeFor(view: string, anchorDate: string, timezone: string) {
  const anchor = new Date(`${anchorDate}T00:00:00.000Z`);
  let startDate = anchorDate;
  let endDate: string;
  if (view === "month") {
    startDate = `${anchorDate.slice(0, 7)}-01`;
    const nextMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
    endDate = nextMonth.toISOString().slice(0, 10);
  } else if (view === "week") {
    startDate = addLocalDays(anchorDate, -((anchor.getUTCDay() + 6) % 7));
    endDate = addLocalDays(startDate, 7);
  } else {
    endDate = addLocalDays(startDate, 90);
  }
  return {
    from: zonedLocalDateTimeToUtc(`${startDate}T00:00`, timezone),
    to: zonedLocalDateTimeToUtc(`${endDate}T00:00`, timezone),
  };
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const context = await requirePageContext();
  const search = await searchParams;
  const view = ["month", "week", "list"].includes(value(search, "view") || "") ? value(search, "view")! : "month";
  const client = await db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } });
  const anchorDate = validDateInput(value(search, "date")) || dateInTimezone(new Date(), client.timezone);
  const range = rangeFor(view, anchorDate, client.timezone);
  const [entries, accounts] = await Promise.all([
    listCalendarEntries(context, {
      ...range,
      platform: value(search, "platform") || undefined,
      accountId: value(search, "accountId") || undefined,
      status: value(search, "status") || undefined,
    }),
    db.socialAccount.findMany({ where: { clientId: context.clientId }, orderBy: [{ platform: "asc" }, { displayName: "asc" }] }),
  ]);
  const days = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = dateInTimezone(entry.scheduledAt!, client.timezone);
    days.set(key, [...(days.get(key) || []), entry]);
  }
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>内容日历</h1><p className="muted">直接投影 ContentPlan / ContentItem / ContentVersion / Approval / PublishJob。</p></div><div className="row"><Link className="badge" href={`/calendar?view=month&date=${anchorDate}`}>月</Link><Link className="badge" href={`/calendar?view=week&date=${anchorDate}`}>周</Link><Link className="badge" href={`/calendar?view=list&date=${anchorDate}`}>列表</Link></div></div>
      <section className="card" style={{ marginBottom: "1rem" }}><form method="get" className="row"><input type="hidden" name="view" value={view} /><label>日期<input type="date" name="date" defaultValue={anchorDate} /></label><label>平台<select name="platform" defaultValue={value(search, "platform") || ""}><option value="">全部</option>{[...new Set(accounts.map((account) => account.platform))].map((platform) => <option key={platform}>{platform}</option>)}</select></label><label>账号<select name="accountId" defaultValue={value(search, "accountId") || ""}><option value="">全部</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.platform} · {account.displayName}</option>)}</select></label><label>状态<select name="status" defaultValue={value(search, "status") || ""}><option value="">全部</option>{["DRAFT", "REVIEW_PENDING", "APPROVED", "SCHEDULED", "RUNNING", "PUBLISHED", "FAILED", "UNKNOWN"].map((status) => <option key={status}>{status}</option>)}</select></label><button>筛选</button></form></section>
      <section className={`calendar-grid ${view === "list" ? "calendar-list" : ""}`}>
        {[...days.entries()].map(([day, dayEntries]) => <article className="card" key={day}><h2>{day}</h2><div className="list">{dayEntries.map((entry) => <div className="list-item stack" key={entry.id}><div className="row"><span className="badge">{entry.account.platform}</span><span className="badge">{entry.status}</span><strong>{entry.plan.theme}</strong></div><small className="muted">{entry.account.displayName} · {entry.scheduledAt!.toLocaleString("zh-CN", { timeZone: client.timezone })} · v{entry.currentVersion?.version ?? "—"}</small>{entry.status === "SCHEDULED" && <form action="/api/calendar/reschedule" method="post" className="row"><input type="hidden" name="contentItemId" value={entry.id} /><input type="hidden" name="timezone" value={client.timezone} /><input type="datetime-local" name="scheduledAt" required /><button className="secondary">服务层重排</button></form>}<form action={`/api/ai/content/${entry.id}/generate`} method="post" className="row"><input name="intent" required placeholder="AI 生成意图（仍需人工审批）" /><button>生成新版本</button></form></div>)}</div></article>)}
        {entries.length === 0 && <div className="card"><p className="muted">当前范围没有已排期内容。Calendar 不会创建第二套排期记录。</p></div>}
      </section>
    </OperatorShell>
  );
}
