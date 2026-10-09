import { RestaurantValidationError } from "./restaurant";

export interface ScheduleInterval {
  /** 0 — воскресенье, 6 — суббота. */
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
}

const MINUTES = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const minuteOfDay = (time: string): number => {
  const match = MINUTES.exec(time);
  if (!match) throw new RestaurantValidationError("время должно иметь формат HH:mm");
  return Number(match[1]) * 60 + Number(match[2]);
};

export function validateSchedule(intervals: readonly ScheduleInterval[]): void {
  if (!Array.isArray(intervals) || intervals.length > 7) {
    throw new RestaurantValidationError("расписание должно содержать не более семи дней");
  }
  const seen = new Set<number>();
  for (const interval of intervals) {
    if (
      !Number.isInteger(interval?.dayOfWeek) ||
      interval.dayOfWeek < 0 ||
      interval.dayOfWeek > 6
    ) {
      throw new RestaurantValidationError("день недели должен быть от 0 до 6");
    }
    if (seen.has(interval.dayOfWeek))
      throw new RestaurantValidationError("день недели повторяется");
    seen.add(interval.dayOfWeek);
    if (minuteOfDay(interval.opensAt) === minuteOfDay(interval.closesAt)) {
      throw new RestaurantValidationError("начало и конец смены должны различаться");
    }
  }
}

/** Конец интервала не включён; ночная смена относится к дню начала. */
export function isOpenAt(
  intervals: readonly ScheduleInterval[],
  timeZone: string,
  at: Date,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = WEEKDAYS.indexOf(get("weekday"));
  const now = Number(get("hour")) * 60 + Number(get("minute"));
  return intervals.some((interval) => {
    const opens = minuteOfDay(interval.opensAt);
    const closes = minuteOfDay(interval.closesAt);
    if (opens < closes) return interval.dayOfWeek === day && opens <= now && now < closes;
    return (
      (interval.dayOfWeek === day && now >= opens) ||
      ((interval.dayOfWeek + 1) % 7 === day && now < closes)
    );
  });
}
