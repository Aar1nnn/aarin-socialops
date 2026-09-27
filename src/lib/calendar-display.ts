function partsInZone(value: Date | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function calendarDateKey(value: Date | string | null, timeZone: string): string | null {
  if (!value) return null;
  const parts = partsInZone(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function moveCalendarDatePreservingClock(value: Date | string, targetDate: string, timeZone: string): string {
  const parts = partsInZone(value, timeZone);
  return `${targetDate}T${parts.hour}:${parts.minute}`;
}

export function calendarGrid(view: "month" | "week" | "list", anchorDate: string) {
  const [year, month, day] = anchorDate.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const first = view === "month" ? new Date(Date.UTC(year, month - 1, 1)) : anchor;
  if (view !== "list") first.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const dayCount = view === "week" ? 7 : view === "month"
    ? Math.ceil((new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7) * 7
    : 0;
  return { startDate: first.toISOString().slice(0, 10), dayCount };
}
