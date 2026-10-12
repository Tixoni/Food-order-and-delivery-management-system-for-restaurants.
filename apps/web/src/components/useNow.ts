import { useEffect, useState } from "react";

/** Текущее время, обновляемое раз в `intervalMs`, — для обратных отсчётов. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** «2:05» — сколько осталось до срока; отрицательное — «0:00». */
export function countdown(until: string | null, now: number): string {
  if (!until) return "";
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
