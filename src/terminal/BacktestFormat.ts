// Number and date formatting for the backtest panel (Indian lakh/crore style).

/** ₹ amount; `short` gives 10.9L / 1.23Cr for axes. */
export function formatRupees(value: number | null | undefined, short = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (short || abs >= 1e7) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 1 : 2)}Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 1 : 2)}L`;
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** A fraction as a signed % (0.0123 → +1.23%). */
export function formatPct(value: number | null | undefined, digits = 2, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  return `${signed && pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(digits)}%`;
}

export function formatR(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}R`;
}

export function formatRatio(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

/** Session day key → "4 Nov 2026" (day keys are UTC midnight of the IST date). */
export function formatDate(time: number, year = true): string {
  return new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Day key ↔ <input type="date"> value. */
export const toInputDate = (time: number) => new Date(time).toISOString().slice(0, 10);
export const fromInputDate = (value: string) => (value ? Date.parse(`${value}T00:00:00Z`) : NaN);
