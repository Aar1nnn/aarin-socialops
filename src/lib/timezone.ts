import { AppError } from "./errors";

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function assertValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new AppError("时区不是有效的 IANA timezone。", 400, "INVALID_TIMEZONE");
  }
}

export function zonedLocalDateTimeToUtc(localDateTime: string, timeZone: string): Date {
  assertValidTimeZone(timeZone);
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (!match) throw new AppError("排期时间格式无效。", 400, "INVALID_SCHEDULE_TIME");
  const expected = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0),
  };
  const naiveUtc = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute, expected.second);
  let candidate = naiveUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsInZone(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate -= representedAsUtc - naiveUtc;
  }
  const result = new Date(candidate);
  const roundTrip = partsInZone(result, timeZone);
  if (Object.keys(expected).some((key) => expected[key as keyof typeof expected] !== roundTrip[key as keyof typeof roundTrip])) {
    throw new AppError("该本地时间在所选时区不存在，请选择其他时间。", 400, "INVALID_SCHEDULE_TIME");
  }
  const equivalentInstants = new Set<number>();
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 15) {
    const instant = new Date(result.getTime() + offsetMinutes * 60_000);
    const represented = partsInZone(instant, timeZone);
    if (Object.keys(expected).every((key) => expected[key as keyof typeof expected] === represented[key as keyof typeof represented])) {
      equivalentInstants.add(instant.getTime());
    }
  }
  if (equivalentInstants.size !== 1) {
    throw new AppError("该本地时间存在夏令时歧义，请选择其他时间。", 400, "AMBIGUOUS_SCHEDULE_TIME");
  }
  return result;
}

function partsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}
