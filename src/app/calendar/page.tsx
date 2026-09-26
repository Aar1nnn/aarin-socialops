import { OperatorShell } from "@/components/operator-shell";
import { CalendarBoard } from "@/components/calendar-board";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { statusLabel } from "@/lib/presentation/status";
import { listCalendarEntries } from "@/services/calendar-service";
import { calendarDateKey, calendarGrid } from "@/lib/calendar-display";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const view = query.view === "week" || query.view === "list" ? query.view : "month";
  const workspace = await db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } });
  const today = calendarDateKey(new Date(), workspace.timezone)!;
  const anchorDate = typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date)
    && !Number.isNaN(new Date(`${query.date}T00:00:00Z`).getTime()) ? query.date : today;
  const grid = calendarGrid(view, anchorDate);
  const first = new Date(`${grid.startDate}T00:00:00Z`);
  const from = view === "list" ? undefined : new Date(first.getTime() - 24 * 60 * 60 * 1000);
  const to = view === "list" ? undefined : new Date(first.getTime() + (grid.dayCount + 1) * 24 * 60 * 60 * 1000);
  const [entries, accounts] = await Promise.all([
    listCalendarEntries(context, {
      view,
      from,
      to,
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
      <label>日期<input type="date" name="date" defaultValue={anchorDate} /></label>
      <label>平台<select name="platform" defaultValue={typeof query.platform === "string" ? query.platform : ""}><option value="">全部</option>{[...new Set(accounts.map((account) => account.platform))].map((platform) => <option key={platform}>{platform}</option>)}</select></label>
      <label>账号<select name="accountId" defaultValue={typeof query.accountId === "string" ? query.accountId : ""}><option value="">全部</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.platform} · {account.displayName}</option>)}</select></label>
      <label>状态<select name="status" defaultValue={typeof query.status === "string" ? query.status : ""}><option value="">全部</option>{["DRAFT", "REVIEW_PENDING", "APPROVED", "SCHEDULED", "RUNNING", "PUBLISHED", "UNKNOWN", "FAILED"].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
      <button>应用筛选</button>
    </form></section>
    <section className="card" style={{ marginTop: "1rem" }}><CalendarBoard entries={serialized} view={view} startDate={grid.startDate} dayCount={grid.dayCount} timezone={workspace.timezone} readOnly={context.role === "VIEWER"} /></section>
  </OperatorShell>;
}
