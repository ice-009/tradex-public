import { IST_OFFSET_MS } from "@/core/market/session";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar fields of an epoch-ms instant in IST (no DST, so a fixed offset is exact). */
export function istClock(time: number) {
  const date = new Date(time + IST_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function formatPrice(value: number, decimals = 2) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Compact number for volume-style values: 1.2K / 3.4M / 5.6B. */
export function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(abs >= 100 ? 0 : 2);
}

/** Decimal places that make sense for a value's magnitude (indicator legends, axes). */
export function decimalsFor(value: number) {
  const abs = Math.abs(value);
  if (abs === 0) return 2;
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function formatValue(value: number) {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100_000 ? formatCompact(value) : formatPrice(value, decimalsFor(value));
}

export function formatCrosshairTime(time: number, intraday: boolean) {
  const p = istClock(time);
  const date = `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month]} '${String(p.year).slice(2)}`;
  return intraday ? `${date}  ${pad(p.hours)}:${pad(p.minutes)}` : date;
}

export function formatTickLabel(time: number, weight: number) {
  const p = istClock(time);
  if (weight >= 60) return String(p.year);
  if (weight >= 50) return MONTHS[p.month];
  if (weight >= 40) return String(p.day);
  return `${pad(p.hours)}:${pad(p.minutes)}`;
}

export { MONTHS };
