import { OperatorShell } from "@/components/operator-shell";
import { CalendarBoard } from "@/components/calendar-board";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { listCalendarEntries } from "@/services/calendar-service";

function resolveRange(view: "month" | "week" | "list", anchor: Date) {
  if (view === "list") return { from: undefined, to: undefined, startDate: anchor.toISOString().slice(0, 10) };
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), view === "month" ? 1 : anchor.getUTCDate()));
  if (view === "week") from.setUTCDate(from.getUTCDate() - from.getUTCDay());
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + (view === "month" ? 35 : 7));
  return { from, to, startDate: from.toISOString().slice(0, 10) };
}
export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const view = query.view === "week" || query.view === "list" ? query.view : "month";
  const anchor = typeof query.date === "string" && !Number.isNaN(new Date(query.date).getTime()) ? new Date(query.date) : new Date();
  const range = resolveRange(view, anchor);
  const [entries, accounts] = await Promise.all([
    listCalendarEntries(context, {
      view,
      from: range.from,
      to: range.to,
      platform: typeof query.platform === "string" && query.platform ? query.platform : undefined,
      accountId: typeof query.accountId === "string" && query.accountId ? query.accountId : undefined,
      status: typeof query.status === "string" && query.status ? query.status : undefined,
    }),
    db.socialAccount.findMany({ where: { clientId: context.clientId }, orderBy: [{ platform: "asc" }, { displayName: "asc" }] }),
  ]);
  const serialized = entries.map((entry) => ({ ...entry, scheduledAt: entry.scheduledAt?.toISOString() || null, queueAt: entry.queueAt?.toISOString() || null }));
  return <OperatorShell context={context}>
    <div className="page-title"><div><h1>内容日历</h1><p className="muted">日历直接使用现有内容、审批和发布任务；拖放只通过服务层更新排期。</p></div></div>
    <section className="card"><form method="get" className="row">
      <label>视图<select name="view" defaultValue={view}><option value="month">月</option><option value="week">周</option><option value="list">列表</option></select></label>
      <label>日期<input type="date" name="date" defaultValue={anchor.toISOString().slice(0, 10)} /></label>
      <label>平台<select name="platform" defaultValue={typeof query.platform === "string" ? query.platform : ""}><option value="">全部</option>{[...new Set(accounts.map((account) => account.platform))].map((platform) => <option key={platform}>{platform}</option>)}</select></label>
      <label>账号<select name="accountId" defaultValue={typeof query.accountId === "string" ? query.accountId : ""}><option value="">全部</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.platform} · {account.displayName}</option>)}</select></label>
      <label>状态<select name="status" defaultValue={typeof query.status === "string" ? query.status : ""}><option value="">全部</option>{["DRAFT", "REVIEW_PENDING", "APPROVED", "SCHEDULED", "RUNNING", "PUBLISHED", "UNKNOWN", "FAILED"].map((status) => <option key={status}>{status}</option>)}</select></label>
      <button>应用筛选</button>
    </form></section>
    <section className="card" style={{ marginTop: "1rem" }}><CalendarBoard entries={serialized} view={view} startDate={range.startDate} /></section>
  </OperatorShell>;
}
