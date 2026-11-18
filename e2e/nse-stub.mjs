// A stand-in for NSE's public archive (nsearchives.nseindia.com), for CI's
// no-broker Docker run (.github/workflows/ci.yml,
// job `docker`). The Market Data Hub, started without broker keys, reads NSE's
// end-of-day files; pointed here (NSE_ARCHIVE_URL) it gets
// generated ones instead, so CI makes no request to NSE and every run sees
// the same kind of data.
//
// Serves, for every weekday up to today (IST):
//   /products/content/sec_bhavdata_full_DDMMYYYY.csv          cash bhavcopy
//   /content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip F&O bhavcopy (stock futures)
//   /archives/equities/bhavcopy/pr/PRDDMMYY.zip                board meetings (results calendar)
//   /content/fo/fo_mktlots.csv, /content/fo/fo_secban.csv     lot sizes, ban list
// Prices are a seeded random walk per symbol (seed = the ticker), the same on
// every run for a given date. Symbols: Tradex's own universe lists
// (data/universe: NIFTY 50/200 and the F&O list), read from STUB_UNIVERSE_DIR.
//
// Usage: node e2e/nse-stub.mjs   (STUB_NSE_PORT, default 8080; STUB_UNIVERSE_DIR, default ./data/universe)

import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const PORT = Number(process.env.STUB_NSE_PORT || 8080);
const UNIVERSE_DIR = process.env.STUB_UNIVERSE_DIR || path.join(process.cwd(), "data", "universe");
const DAY = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
/** The walk starts here; any date after it can be asked for. */
const ORIGIN = Date.UTC(2015, 0, 1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------------ symbols

function universe() {
  const cash = new Set();
  const fno = new Set();
  for (const file of readdirSync(UNIVERSE_DIR)) {
    const text = readFileSync(path.join(UNIVERSE_DIR, file), "utf8");
    if (file.endsWith(".txt")) {
      for (const line of text.split(/\r?\n/)) if (line.trim()) fno.add(line.trim().toUpperCase());
    } else if (file.endsWith(".csv")) {
      const [header, ...rows] = text.split(/\r?\n/);
      const col = header.split(",").findIndex((cell) => cell.trim().toLowerCase() === "symbol");
      for (const row of rows) {
        const symbol = row.split(",")[col]?.trim().toUpperCase();
        if (symbol) cash.add(symbol);
      }
    }
  }
  for (const symbol of fno) cash.add(symbol);
  return { cash: [...cash].sort(), fno: [...fno].sort() };
}
const SYMBOLS = universe();

// ------------------------------------------------------------------ prices

function hash(text) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value) => Math.round(value * 20) / 20; // ₹0.05 ticks
const isWeekday = (day) => ![0, 6].includes(new Date(day).getUTCDay());
const walks = new Map();

/** Daily bars of one symbol from ORIGIN through `day` (every weekday a session), by day key. */
function bars(symbol, day) {
  let walk = walks.get(symbol);
  if (!walk) {
    const rand = random(hash(symbol));
    walk = { rand, price: 80 + rand() * 3_000, vol: 0.012 + rand() * 0.012, drift: 0, volume: Math.round(200_000 + rand() * 5_000_000), next: ORIGIN, count: 0, byDay: new Map() };
    walks.set(symbol, walk);
  }
  for (; walk.next <= day; walk.next += DAY) {
    if (!isWeekday(walk.next)) continue;
    const { rand, vol } = walk;
    if (walk.count++ % 40 === 0) walk.drift = (rand() - 0.45) * 0.004;
    const prev = walk.price;
    const open = prev * (1 + (rand() - 0.5) * vol * 0.6);
    const close = open * (1 + walk.drift + (rand() - 0.5) * 2 * vol);
    walk.price = close;
    walk.byDay.set(walk.next, {
      prev: round(prev),
      o: round(open),
      h: round(Math.max(open, close) * (1 + rand() * vol * 0.7)),
      l: round(Math.min(open, close) * (1 - rand() * vol * 0.7)),
      c: round(close),
      v: Math.round(walk.volume * (0.5 + rand() * 1.5)),
      dp: Math.round((25 + rand() * 50) * 100) / 100,
    });
  }
  return walk.byDay;
}

// ------------------------------------------------------------------ files

const pad = (n) => String(n).padStart(2, "0");
const parts = (day) => {
  const date = new Date(day);
  return { d: pad(date.getUTCDate()), m: pad(date.getUTCMonth() + 1), y: String(date.getUTCFullYear()), mon: MONTHS[date.getUTCMonth()] };
};
const iso = (day) => new Date(day).toISOString().slice(0, 10);
const todayIst = () => Math.floor((Date.now() + IST_MS) / DAY) * DAY;

function cashFile(day) {
  const { d, mon, y } = parts(day);
  const lines = ["SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER"];
  for (const symbol of SYMBOLS.cash) {
    const bar = bars(symbol, day).get(day);
    const avg = round((bar.o + bar.h + bar.l + bar.c) / 4);
    lines.push([symbol, "EQ", `${d}-${mon}-${y}`, bar.prev, bar.o, bar.h, bar.l, bar.c, bar.c, avg, bar.v, ((bar.v * avg) / 1e5).toFixed(2), Math.round(bar.v / 40), Math.round((bar.v * bar.dp) / 100), bar.dp].join(", "));
  }
  return `${lines.join("\n")}\n`;
}

/** The last Thursday of a month (the stub's expiry day). */
function expiryOf(year, month) {
  let day = Date.UTC(year, month + 1, 0);
  while (new Date(day).getUTCDay() !== 4) day -= DAY;
  return day;
}

function lotOf(symbol) {
  return 25 * (1 + (hash(`${symbol}:lot`) % 40));
}

function foFile(day) {
  const date = new Date(day);
  let near = expiryOf(date.getUTCFullYear(), date.getUTCMonth());
  let month = date.getUTCMonth();
  if (near < day) near = expiryOf(date.getUTCFullYear(), ++month);
  const expiries = [near, expiryOf(date.getUTCFullYear(), month + 1), expiryOf(date.getUTCFullYear(), month + 2)];
  const header = "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";
  const lines = [header];
  for (const symbol of SYMBOLS.fno) {
    const bar = bars(symbol, day).get(day);
    const rand = random(hash(`${symbol}:${day}:fo`));
    expiries.forEach((expiry, index) => {
      const premium = 1 + 0.003 * (index + 1);
      const oi = Math.round((5_000_000 / (index + 1)) * (0.5 + rand()));
      const chg = Math.round(oi * (rand() - 0.5) * 0.1);
      const close = round(bar.c * premium);
      const name = `${symbol}${parts(expiry).y.slice(2)}${MONTHS[new Date(expiry).getUTCMonth()].toUpperCase()}FUT`;
      lines.push([iso(day), iso(day), "FO", "NSE", "STF", hash(name) % 100000, "", symbol, "", iso(expiry), iso(expiry), "", "", name, round(bar.o * premium), round(bar.h * premium), round(bar.l * premium), close, close, round(bar.prev * premium), bar.c, close, oi, chg, Math.round(1000 * rand() * 50), "0.00", 100, "F1", lotOf(symbol), "", "", "", "", ""].join(","));
    });
  }
  return `${lines.join("\n")}\n`;
}

/** A one-file zip (stored deflated), as NSE publishes the F&O bhavcopy. */
function zip(name, data) {
  const body = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + body.length, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

function lotsFile() {
  const today = todayIst();
  const months = [0, 1, 2].map((offset) => {
    const date = new Date(Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth() + offset, 1));
    return `${MONTHS[date.getUTCMonth()].toUpperCase()}-${String(date.getUTCFullYear()).slice(2)}`;
  });
  const lines = [`UNDERLYING,SYMBOL,${months.join(",")}`];
  for (const symbol of SYMBOLS.fno) lines.push([symbol, symbol, lotOf(symbol), lotOf(symbol), lotOf(symbol)].join(","));
  return `${lines.join("\n")}\n`;
}

function banFile() {
  let day = todayIst();
  while (!isWeekday(day)) day += DAY;
  const { d, mon, y } = parts(day);
  const banned = SYMBOLS.fno.filter((symbol) => hash(`${symbol}:${day}:ban`) % 60 === 0).slice(0, 3);
  return [`Securities in Ban For Trade Date ${d}-${mon.toUpperCase()}-${y}:`, ...(banned.length ? banned.map((symbol, i) => `${i + 1},${symbol}`) : ["NIL"])].join("\n") + "\n";
}

/** One day's board-meetings file (bmDDMMYYYY.txt in the PR zip): a few companies announce a results date. */
function boardMeetings(day) {
  const lines = ["COMPANY NAME    SYMBOL     : BM DATE    : BM PURPOSE"];
  for (const symbol of SYMBOLS.cash) {
    if (hash(`${symbol}:${day}:bm`) % 25 !== 0) continue;
    const { d, mon, y } = parts(day + (7 + (hash(symbol) % 30)) * DAY);
    lines.push(`${symbol} Limited ${symbol} : ${d}-${mon.toUpperCase()}-${y} : Financial Results To consider and approve the financial results`);
  }
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ server

/** A weekday from ORIGIN through today (IST), or null. */
function sessionDay(dd, mm, yyyy) {
  const day = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isFinite(day) && day >= ORIGIN && day <= todayIst() && isWeekday(day) ? day : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const send = (status, body, type = "text/plain") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  let match;
  if ((match = /^\/products\/content\/sec_bhavdata_full_(\d{2})(\d{2})(\d{4})\.csv$/.exec(url.pathname))) {
    const day = sessionDay(match[1], match[2], match[3]);
    return day === null ? send(404, "not found") : send(200, cashFile(day), "text/csv");
  }
  if ((match = /^\/content\/fo\/BhavCopy_NSE_FO_0_0_0_(\d{4})(\d{2})(\d{2})_F_0000\.csv\.zip$/.exec(url.pathname))) {
    const day = sessionDay(match[3], match[2], match[1]);
    if (day === null) return send(404, "not found");
    const name = url.pathname.split("/").pop().replace(/\.zip$/, "");
    return send(200, zip(name, Buffer.from(foFile(day))), "application/zip");
  }
  if ((match = /^\/archives\/equities\/bhavcopy\/pr\/PR(\d{2})(\d{2})(\d{2})\.zip$/.exec(url.pathname))) {
    const day = sessionDay(match[1], match[2], `20${match[3]}`);
    if (day === null) return send(404, "not found");
    const { d, m, y } = parts(day);
    return send(200, zip(`bm${d}${m}${y}.txt`, Buffer.from(boardMeetings(day))), "application/zip");
  }
  if (url.pathname === "/content/fo/fo_mktlots.csv") return send(200, lotsFile(), "text/csv");
  if (url.pathname === "/content/fo/fo_secban.csv") return send(200, banFile(), "text/csv");
  if (url.pathname === "/healthz") return send(200, "ok");
  return send(404, "not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NSE stub on :${PORT}: ${SYMBOLS.cash.length} stocks, ${SYMBOLS.fno.length} with futures`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
