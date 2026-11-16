import type { PricePoint } from "@/contracts/api";
import { DAY_MS, IST_OFFSET_MS } from "@/core/market/session";
export type { PricePoint };

const sampleSymbols: Record<string, number> = {
  NIFTY: 24550,
  BANKNIFTY: 55250,
  TCS: 3875,
  RELIANCE: 2940,
  INFY: 1480,
  HDFCBANK: 1675,
  ICICIBANK: 1245,
  SBIN: 815,
  AXISBANK: 1120,
  KOTAK: 1775,
  MARUTI: 12900,
  TATAMOTORS: 712,
  BAJAJMOTOR: 9450,
  SUZLON: 58,
  ASHOK: 214,
  NTPC: 364,
  POWERGRID: 314,
  GAIL: 211,
  SUNPHARMA: 1740,
  CIPLA: 1515,
  DRREDDY: 6480,
  LUPIN: 1765,
  BIOCON: 346,
  ITC: 438,
  NESTLEIND: 2515,
  HINDUNILVR: 2320,
  BRITANNIA: 5630,
  COLPAL: 2865,
  DLF: 928,
  PRESTIGE: 1710,
  LODHA: 1294,
  TATASTEEL: 176,
  HINDALCO: 698,
  JSWSTEEL: 914,
  VEDL: 432,
  MOIL: 392,
  INDIGO: 4345,
  SPICEJET: 63,
  AIRTEL: 1418,
  VODAFONE: 15,
  JIO: 298,
  WIPRO: 522,
  HCL: 1565,
  TECH: 4895,
  IRFC: 141,
};

function hashSymbol(symbol: string) {
  return symbol.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const MARKET_OPEN_MINUTES_IST = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 30;

function getISTDate(date: Date) {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function isISTTradingDay(date: Date) {
  const day = getISTDate(date).getUTCDay();
  return day !== 0 && day !== 6;
}

function buildDateFromIST(baseDate: Date, minutesFromMidnight: number) {
  const istDate = getISTDate(baseDate);
  return new Date(
    Date.UTC(
      istDate.getUTCFullYear(),
      istDate.getUTCMonth(),
      istDate.getUTCDate(),
      0,
      minutesFromMidnight,
      0,
      0,
    ) - IST_OFFSET_MS,
  );
}

function getMinutesInIST(date: Date) {
  const istDate = getISTDate(date);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

function getPreviousISTTradingDay(date: Date) {
  let probe = new Date(date.getTime() - DAY_MS);
  while (!isISTTradingDay(probe)) {
    probe = new Date(probe.getTime() - DAY_MS);
  }
  return probe;
}

function alignToMarketSession(minutes: number, intervalMinutes: number) {
  const sessionProgress = Math.max(0, minutes - MARKET_OPEN_MINUTES_IST);
  const steps = Math.floor(sessionProgress / intervalMinutes);
  return Math.min(
    MARKET_CLOSE_MINUTES_IST,
    MARKET_OPEN_MINUTES_IST + steps * intervalMinutes,
  );
}

function getInitialIntradayCursor(intervalMinutes: number) {
  const cursor = new Date();

  if (!isISTTradingDay(cursor)) {
    return buildDateFromIST(getPreviousISTTradingDay(cursor), MARKET_CLOSE_MINUTES_IST);
  }

  const currentMinutes = getMinutesInIST(cursor);
  if (currentMinutes < MARKET_OPEN_MINUTES_IST) {
    return buildDateFromIST(getPreviousISTTradingDay(cursor), MARKET_CLOSE_MINUTES_IST);
  }

  if (currentMinutes > MARKET_CLOSE_MINUTES_IST) {
    return buildDateFromIST(cursor, alignToMarketSession(MARKET_CLOSE_MINUTES_IST, intervalMinutes));
  }

  return buildDateFromIST(cursor, alignToMarketSession(currentMinutes, intervalMinutes));
}

function getPreviousIntradayCandleTime(cursor: Date, intervalMinutes: number) {
  const currentMinutes = getMinutesInIST(cursor);
  const previousMinutes = currentMinutes - intervalMinutes;

  if (previousMinutes < MARKET_OPEN_MINUTES_IST) {
    return buildDateFromIST(getPreviousISTTradingDay(cursor), MARKET_CLOSE_MINUTES_IST);
  }

  return buildDateFromIST(cursor, previousMinutes);
}

export const generateSampleSeries = (symbol: string, days = 90): PricePoint[] => {
  const normalized = symbol.toUpperCase();
  const base = sampleSymbols[normalized] ?? (120 + (hashSymbol(normalized) % 3200));
  const seed = hashSymbol(normalized);
  const random = createSeededRandom(seed);
  const annualTrend = (random() - 0.5) * 0.28;
  const lateReversalAnnual = (random() - 0.5) * 0.22;
  const cycleSize = days > 1500 ? 55 + Math.floor(random() * 45) : days > 500 ? 24 + Math.floor(random() * 20) : 4 + Math.floor(random() * 5);
  const cycleAmplitude = days > 1500 ? 0.009 : days > 500 ? 0.007 : 0.012;
  const noiseAmplitude = days > 1500 ? 0.004 : days > 500 ? 0.0055 : 0.008;
  const reversionStrength = days > 1500 ? 0.03 : days > 500 ? 0.024 : 0.012;
  const volumeBase = 1_800_000 + Math.floor(random() * 7_500_000);
  const series: PricePoint[] = [];
  let price = base;
  const phase = random() * Math.PI * 2;

  for (let i = days; i > 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const progress = (days - i) / Math.max(days - 1, 1);
    const targetPath = base * (1 + annualTrend * progress * 1.35);
    const dailyTrend = (annualTrend / 252) * (0.75 + progress * 0.4);
    const trendComponent = dailyTrend;
    const cycleComponent = Math.sin((days - i) / cycleSize + phase) * cycleAmplitude;
    const reversalComponent =
      progress > 0.8 ? (lateReversalAnnual / 252) * ((progress - 0.8) / 0.2) : 0;
    const meanReversion = ((targetPath - price) / Math.max(base, 1)) * reversionStrength;
    const noise = (random() - 0.5) * noiseAmplitude;
    const drift = trendComponent + cycleComponent + reversalComponent + meanReversion + noise;
    const wickFactor = 0.006 + random() * 0.022;
    const open = price;
    const close = Math.max(1, open * (1 + drift));
    const high = Math.max(open, close) * (1 + wickFactor);
    const low = Math.min(open, close) * (1 - wickFactor * (0.7 + random() * 0.8));
    const volume =
      volumeBase +
      Math.floor((0.7 + random() * 0.6 + Math.abs(drift) * 20) * 400_000);

    series.push({
      date: date.toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });

    price = close;
  }

  return series;
};

export function generateSampleIntradaySeries(
  symbol: string,
  intervalMinutes: number,
  points: number,
): PricePoint[] {
  const normalized = symbol.toUpperCase();
  const base = sampleSymbols[normalized] ?? (120 + (hashSymbol(normalized) % 3200));
  const random = createSeededRandom(hashSymbol(`${normalized}-${intervalMinutes}-${points}`));
  const series: PricePoint[] = [];
  let price = base;
  const timestamps: Date[] = [];
  let cursor = getInitialIntradayCursor(intervalMinutes);

  while (timestamps.length < points) {
    timestamps.push(cursor);
    cursor = getPreviousIntradayCandleTime(cursor, intervalMinutes);
  }

  timestamps.reverse();

  timestamps.forEach((timestamp, index) => {
    const progress = index / Math.max(timestamps.length - 1, 1);
    const cycleComponent = Math.sin(progress * Math.PI * 6) * 0.006;
    const trendComponent = (random() - 0.5) * 0.002 + progress * 0.0015;
    const noise = (random() - 0.5) * 0.01;
    const drift = cycleComponent + trendComponent + noise;
    const wickFactor = 0.0015 + random() * 0.004;
    const open = price;
    const close = Math.max(1, open * (1 + drift));
    const high = Math.max(open, close) * (1 + wickFactor);
    const low = Math.min(open, close) * (1 - wickFactor * (0.8 + random() * 0.6));
    const volume = 50_000 + Math.floor((0.8 + random() * 0.7 + Math.abs(drift) * 30) * 15_000);

    series.push({
      date: timestamp.toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });

    price = close;
  });

  return series;
}
