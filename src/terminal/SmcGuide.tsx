"use client";

import { useState, type ReactNode } from "react";
import { SMC_COLORS } from "@/core/indicators/smc";
import { Modal } from "./ui";

// In-app lesson for the SMC indicator: one concept per step, each with a
// diagram drawn in the same colours the indicator uses on the chart.

const UP = SMC_COLORS.bull;
const DOWN = SMC_COLORS.bear;
const MUTED = "#8a93a6";
const TEXT = "#d6dbe6";

function Diagram({ children, height = 150 }: { children: ReactNode; height?: number }) {
  return (
    <svg className="tx-guide-svg" viewBox={`0 0 320 ${height}`} role="img" aria-hidden="true">
      {children}
    </svg>
  );
}

/** A candle in SVG coordinates (y grows downward, so "high" is the smaller y). */
function Candle({ x, open, close, high, low, w = 10 }: { x: number; open: number; close: number; high: number; low: number; w?: number }) {
  const color = close <= open ? UP : DOWN;
  return (
    <g>
      <line x1={x} x2={x} y1={high} y2={low} stroke={color} strokeWidth={1.5} />
      <rect x={x - w / 2} y={Math.min(open, close)} width={w} height={Math.max(2, Math.abs(close - open))} fill={color} />
    </g>
  );
}

function Tag({ x, y, children, color = TEXT, anchor = "middle" }: { x: number; y: number; children: ReactNode; color?: string; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} fill={color} fontSize={10.5} fontWeight={600} textAnchor={anchor}>
      {children}
    </text>
  );
}

const zigzag = (points: Array<[number, number]>) => points.map(([x, y]) => `${x},${y}`).join(" ");

interface Lesson {
  title: string;
  diagram: ReactNode;
  body: ReactNode;
}

const LESSONS: Lesson[] = [
  {
    title: "1 · The idea behind SMC",
    diagram: (
      <Diagram>
        <polyline points={zigzag([[10, 120], [60, 70], [95, 95], [150, 40], [185, 70], [250, 20], [300, 45]])} fill="none" stroke={MUTED} strokeWidth={2} />
        <rect x={80} y={88} width={240} height={14} fill={SMC_COLORS.bullOb} opacity={0.2} />
        <Tag x={200} y={99} color={SMC_COLORS.bullOb}>
          zone where big buyers acted
        </Tag>
        <line x1={150} x2={320} y1={40} y2={40} stroke={UP} strokeDasharray="4 3" />
        <Tag x={235} y={36} color={UP}>
          structure level
        </Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>
          <b>Smart Money Concepts</b> reads a chart as the footprint of large players (funds, institutions). They trade size, so they need
          <b> liquidity</b> (lots of orders to trade against) and they leave <b>imbalances</b> when they push price fast.
        </p>
        <p>The indicator doesn&apos;t predict anything by itself. It automatically marks three things you would otherwise draw by hand:</p>
        <ul>
          <li><b>Structure</b>: which way the trend is going, and when it breaks (HH/HL, BOS, CHoCH).</li>
          <li><b>Zones</b>: where price may react (order blocks, fair value gaps, premium/discount).</li>
          <li><b>Liquidity</b>: where stop-losses are likely bunched (equal highs/lows, weak highs/lows).</li>
        </ul>
      </>
    ),
  },
  {
    title: "2 · Market structure: HH, HL, LH, LL",
    diagram: (
      <Diagram>
        <polyline points={zigzag([[10, 130], [55, 80], [90, 105], [145, 50], [180, 80], [235, 20]])} fill="none" stroke={UP} strokeWidth={2} />
        <Tag x={55} y={73}>H</Tag>
        <Tag x={90} y={120}>HL</Tag>
        <Tag x={145} y={43}>HH</Tag>
        <Tag x={180} y={95}>HL</Tag>
        <Tag x={235} y={14}>HH</Tag>
        <polyline points={zigzag([[245, 30], [265, 70], [280, 55], [300, 100], [310, 90]])} fill="none" stroke={DOWN} strokeWidth={2} />
        <Tag x={280} y={48}>LH</Tag>
        <Tag x={300} y={114}>LL</Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>Price moves in legs. The turning points are <b>swing highs</b> and <b>swing lows</b>, and the indicator labels each one against the previous one:</p>
        <ul>
          <li><b>HH</b> higher high and <b>HL</b> higher low: an <span style={{ color: UP }}>uptrend</span>.</li>
          <li><b>LH</b> lower high and <b>LL</b> lower low: a <span style={{ color: DOWN }}>downtrend</span>.</li>
        </ul>
        <p>
          A swing point is only confirmed once enough bars have passed without exceeding it. That is the <b>swing length</b> setting (50 bars by
          default), so labels appear <i>after</i> the fact. That&apos;s normal: structure is about where we are, not a forecast.
        </p>
      </>
    ),
  },
  {
    title: "3 · BOS vs CHoCH: continuation or reversal",
    diagram: (
      <Diagram>
        <polyline points={zigzag([[10, 125], [60, 60], [95, 95], [150, 30], [190, 80], [225, 55], [290, 125]])} fill="none" stroke={MUTED} strokeWidth={2} />
        <line x1={60} x2={125} y1={60} y2={60} stroke={UP} strokeWidth={1.5} />
        <Tag x={92} y={55} color={UP}>BOS</Tag>
        <line x1={190} x2={248} y1={80} y2={80} stroke={DOWN} strokeWidth={1.5} />
        <Tag x={219} y={93} color={DOWN}>CHoCH</Tag>
        <Tag x={190} y={74} color={MUTED}>last HL</Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>Both are a candle <b>closing</b> beyond the last swing point. The difference is the direction relative to the trend:</p>
        <ul>
          <li>
            <b style={{ color: UP }}>BOS (Break of Structure)</b>: price breaks the last high <i>in the direction of the trend</i>. The trend continues.
          </li>
          <li>
            <b style={{ color: DOWN }}>CHoCH (Change of Character)</b>: the <i>first</i> break against the trend, here closing below the last higher low.
            It&apos;s the earliest warning that the trend may be turning.
          </li>
        </ul>
        <p>
          On the chart, <b>solid</b> lines with bold labels are <b>swing</b> structure (the big picture). <b>Dashed</b> lines are <b>internal</b> structure
          (5-bar swings), the small moves inside a leg. Traders often use internal CHoCH to time entries.
        </p>
      </>
    ),
  },
  {
    title: "4 · Order blocks (OB)",
    diagram: (
      <Diagram>
        <line x1={150} x2={320} y1={50} y2={50} stroke={UP} strokeWidth={1.5} />
        <Tag x={300} y={45} color={UP}>BOS</Tag>
        <rect x={93} y={92} width={227} height={28} fill={SMC_COLORS.bullOb} opacity={0.22} stroke={SMC_COLORS.bullOb} strokeOpacity={0.6} />
        <Tag x={312} y={110} color={SMC_COLORS.bullOb} anchor="end">Bull OB</Tag>
        <Candle x={40} open={70} close={80} high={65} low={85} />
        <Candle x={58} open={80} close={90} high={76} low={95} />
        <Candle x={76} open={88} close={98} high={84} low={104} />
        <Candle x={98} open={96} close={112} high={92} low={120} />
        <Candle x={118} open={110} close={80} high={76} low={114} />
        <Candle x={136} open={82} close={55} high={50} low={85} />
        <Candle x={154} open={56} close={38} high={34} low={60} />
        <Candle x={180} open={40} close={60} high={36} low={64} />
        <Candle x={200} open={60} close={88} high={56} low={96} />
        <Candle x={222} open={90} close={100} high={86} low={104} />
        <Candle x={244} open={98} close={70} high={66} low={102} />
        <Candle x={266} open={70} close={45} high={40} low={74} />
        <Tag x={222} y={135} color={MUTED}>retest → reaction</Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>
          An <b>order block</b> is the candle where the move that broke structure started. For a bullish OB it&apos;s the lowest candle of the leg
          (usually the last down-candle) before the rally that made a BOS/CHoCH. The idea is that big buyers filled orders there, so price often
          reacts when it comes back.
        </p>
        <ul>
          <li><b style={{ color: SMC_COLORS.bullOb }}>Blue boxes</b> = bullish OBs (possible support). <b style={{ color: SMC_COLORS.bearOb }}>Red boxes</b> = bearish OBs (possible resistance).</li>
          <li>Boxes labelled <b>Swing OB</b> come from big-picture breaks and carry more weight than plain (internal) OBs.</li>
          <li>When price trades all the way through a box it is <b>mitigated</b> and disappears from the chart.</li>
          <li>To keep the chart clean, only the order blocks <b>nearest to price</b> are shown (2 below, 2 above by default).</li>
        </ul>
      </>
    ),
  },
  {
    title: "5 · Fair value gaps (FVG)",
    diagram: (
      <Diagram>
        <rect x={80} y={60} width={240} height={30} fill={SMC_COLORS.bullFvg} opacity={0.18} />
        <Tag x={312} y={79} color={SMC_COLORS.bullFvg} anchor="end">FVG ↑</Tag>
        <line x1={80} x2={110} y1={90} y2={90} stroke={MUTED} strokeDasharray="2 2" />
        <line x1={110} x2={140} y1={60} y2={60} stroke={MUTED} strokeDasharray="2 2" />
        <Candle x={90} open={112} close={96} high={90} low={118} w={14} />
        <Candle x={115} open={98} close={44} high={38} low={102} w={14} />
        <Candle x={140} open={48} close={34} high={28} low={60} w={14} />
        <Tag x={90} y={134} color={MUTED}>1</Tag>
        <Tag x={115} y={134} color={MUTED}>2</Tag>
        <Tag x={140} y={134} color={MUTED}>3</Tag>
        <Candle x={200} open={40} close={58} high={36} low={62} />
        <Candle x={222} open={58} close={78} high={55} low={84} />
        <Candle x={244} open={76} close={52} high={48} low={80} />
        <Tag x={225} y={110} color={MUTED}>price returns to fill</Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>
          A <b>fair value gap</b> is a three-candle imbalance. Candle 2 moves so fast that candle 3&apos;s low never comes back down to candle 1&apos;s
          high. That leaves a price range where only one side traded.
        </p>
        <ul>
          <li><b style={{ color: SMC_COLORS.bullFvg }}>Green FVG ↑</b> = bullish gap (price may dip into it and bounce). <b style={{ color: SMC_COLORS.bearFvg }}>Orange FVG ↓</b> = bearish gap.</li>
          <li>Tiny gaps are ignored: candle 2&apos;s body must be at least 2× the average body size.</li>
          <li>Once price trades back through the gap it is <b>filled</b> and removed.</li>
          <li>FVGs are off by default on a plain SMC indicator (they add clutter). Turn on &quot;Fair value gaps&quot; in its settings; the SMC layouts already show the nearest one.</li>
        </ul>
        <p>Many SMC traders look for an FVG <i>inside</i> an order block, because two reasons to react sit at the same price.</p>
      </>
    ),
  },
  {
    title: "6 · Liquidity: equal highs/lows",
    diagram: (
      <Diagram>
        <polyline points={zigzag([[10, 110], [70, 40], [120, 85], [170, 41], [200, 75], [230, 22], [290, 120]])} fill="none" stroke={MUTED} strokeWidth={2} />
        <line x1={70} x2={170} y1={40} y2={41} stroke={DOWN} strokeDasharray="2 3" />
        <Tag x={120} y={34} color={DOWN}>EQH</Tag>
        <Tag x={170} y={22} color={MUTED}>stops resting here</Tag>
        <Tag x={252} y={20} color={TEXT}>sweep</Tag>
      </Diagram>
    ),
    body: (
      <>
        <p>
          When two highs form at almost the same price, that&apos;s <b>EQH</b> (equal highs). Two lows form <b>EQL</b>. Retail traders put stop-losses just
          beyond these obvious levels, so a pool of orders builds there.
        </p>
        <p>
          SMC expects price to be drawn to that pool: a quick spike above EQH that triggers those stops (a <b>liquidity sweep</b>), often followed by a
          reversal. In practice EQH/EQL are used as <b>targets</b>, or as a warning not to place your own stop right there.
        </p>
        <p>Here &quot;equal&quot; means within 0.1 × ATR(200) of each other, using small 3-bar swings.</p>
      </>
    ),
  },
  {
    title: "7 · Premium, discount & strong/weak highs",
    diagram: (
      <Diagram>
        <rect x={40} y={18} width={270} height={56} fill={SMC_COLORS.premium} opacity={0.1} />
        <rect x={40} y={74} width={270} height={56} fill={SMC_COLORS.discount} opacity={0.1} />
        <line x1={40} x2={310} y1={74} y2={74} stroke={MUTED} strokeDasharray="4 3" />
        <line x1={40} x2={310} y1={18} y2={18} stroke={DOWN} />
        <line x1={40} x2={310} y1={130} y2={130} stroke={UP} />
        <Tag x={300} y={14} color={DOWN} anchor="end">Weak High (target)</Tag>
        <Tag x={300} y={144} color={UP} anchor="end">Strong Low</Tag>
        <Tag x={300} y={50} color={SMC_COLORS.premium} anchor="end">Premium: expensive</Tag>
        <Tag x={300} y={70} color={MUTED} anchor="end">Equilibrium 50%</Tag>
        <Tag x={300} y={108} color={SMC_COLORS.discount} anchor="end">Discount: cheap</Tag>
        <polyline points={zigzag([[45, 125], [90, 40], [130, 95], [170, 30], [200, 100]])} fill="none" stroke={TEXT} strokeWidth={1.5} />
      </Diagram>
    ),
    body: (
      <>
        <p>
          Take the current swing range, from the swing low to the swing high. The top part is <b style={{ color: SMC_COLORS.premium }}>premium</b>
          (price is expensive) and the bottom part is <b style={{ color: SMC_COLORS.discount }}>discount</b> (price is cheap). The middle (50%) is
          <b> equilibrium</b>. The indicator can shade the extreme bands and the equilibrium band: turn on &quot;Premium / discount zones&quot; in
          its settings (the SMC layouts have it on).
        </p>
        <ul>
          <li>In an uptrend, SMC traders look for buys in <b>discount</b> (bullish OB/FVG below 50%), not in premium.</li>
          <li>In a downtrend, they look for sells in premium.</li>
          <li>
            <b>Strong Low</b> = the low that produced the latest bullish break. Buyers defended it, so it&apos;s a good place for a stop behind.
            <b> Weak High</b> = the high the trend hasn&apos;t broken yet. It&apos;s the likely next target. (In a downtrend these flip.)
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "8 · Putting it together: a top-down trade",
    diagram: (
      <Diagram height={120}>
        <rect x={8} y={20} width={92} height={80} rx={6} fill="none" stroke={MUTED} />
        <rect x={114} y={20} width={92} height={80} rx={6} fill="none" stroke={MUTED} />
        <rect x={220} y={20} width={92} height={80} rx={6} fill="none" stroke={MUTED} />
        <Tag x={54} y={40}>1h / Daily</Tag>
        <Tag x={54} y={60} color={UP}>bias: BOS ↑</Tag>
        <Tag x={54} y={80} color={MUTED}>swing structure</Tag>
        <Tag x={160} y={40}>15m</Tag>
        <Tag x={160} y={60} color={SMC_COLORS.bullOb}>pullback into</Tag>
        <Tag x={160} y={80} color={SMC_COLORS.bullOb}>discount OB/FVG</Tag>
        <Tag x={266} y={40}>5m</Tag>
        <Tag x={266} y={60} color={UP}>internal CHoCH ↑</Tag>
        <Tag x={266} y={80} color={MUTED}>= entry trigger</Tag>
        <path d="M100 60 H114 M206 60 H220" stroke={MUTED} />
      </Diagram>
    ),
    body: (
      <>
        <ol>
          <li><b>Bias (higher timeframe).</b> On 1h (intraday) or Daily (swing), read the last <b>swing</b> BOS/CHoCH. Latest BOS up → only look for longs.</li>
          <li><b>Location.</b> Wait for price to pull back into <b>discount</b>, ideally into a bullish order block or FVG. Don&apos;t buy in premium.</li>
          <li><b>Trigger (lower timeframe).</b> On 15m/5m, wait for an <b>internal CHoCH up</b> inside that zone: the pullback has stopped making lower lows.</li>
          <li><b>Stop.</b> Just beyond the order block / the strong low that produced the CHoCH.</li>
          <li><b>Target.</b> The nearest liquidity: the <b>weak high</b>, EQH, or a bearish OB above. Check that it&apos;s at least 2× your risk (use the Long Position tool).</li>
        </ol>
        <p>The <b>SMC</b> layouts in the Layouts menu set this up: the higher timeframe on top, lower timeframes for the trigger.</p>
      </>
    ),
  },
  {
    title: "9 · Honest caveats",
    diagram: (
      <Diagram height={90}>
        <Tag x={160} y={40} color={TEXT}>Concepts ≠ edge</Tag>
        <Tag x={160} y={62} color={MUTED}>test before you trade real money</Tag>
      </Diagram>
    ),
    body: (
      <>
        <ul>
          <li>
            SMC is a way of <b>describing</b> price action, not a proven edge. Even LuxAlgo, whose TradingView script made it popular, states there&apos;s no
            supporting data that these concepts trade alongside institutional liquidity.
          </li>
          <li>
            Swing points are confirmed late (50 bars for swing structure), and many order blocks fail. Treat every zone as a <i>scenario</i>, and act only
            when structure, location and trigger line up.
          </li>
          <li>SEBI&apos;s 2024 study found 93% of individual F&amp;O traders lost money (FY22–FY24). Size small, use stops, and keep a journal.</li>
          <li>Settings: fewer bars of swing length = more, noisier structure. Toggle components off in the indicator settings to reduce clutter.</li>
        </ul>
      </>
    ),
  },
];

export function SmcGuide({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const lesson = LESSONS[step];

  return (
    <Modal title="Learn: Smart Money Concepts" onClose={onClose} width={720}>
      <div className="tx-guide">
        <nav className="tx-guide-nav">
          {LESSONS.map((entry, index) => (
            <button
              type="button"
              key={entry.title}
              className={index === step ? "is-active" : ""}
              onClick={() => setStep(index)}
            >
              {entry.title}
            </button>
          ))}
        </nav>
        <article className="tx-guide-body">
          <h3>{lesson.title}</h3>
          {lesson.diagram}
          {lesson.body}
        </article>
      </div>
      <div className="tx-modal-foot">
        <span className="tx-guide-step">
          {step + 1} / {LESSONS.length}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="tx-btn" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>
          Back
        </button>
        {step < LESSONS.length - 1 ? (
          <button type="button" className="tx-btn tx-btn-primary" onClick={() => setStep((value) => value + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="tx-btn tx-btn-primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </Modal>
  );
}
