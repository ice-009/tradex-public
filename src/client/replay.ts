import { useSyncExternalStore } from "react";
import { REPLAY_SPEEDS, nextBarLimit, previousBarLimit, revealLimit, stepIntervalMs } from "@/core/reference/replay";
import { sessionCloseMs } from "@/core/reference/timeMachine";
import { onTimeMachineChange, setAsOf, timeMachine, timeMachineDay } from "@/client/timeMachine";

// Replay in the Time Machine (issue #32), in the browser: step the day shown a
// session back or forward, play it forward at a chosen speed, and reveal an
// intraday chart's next session a bar at a time. The day lives in the URL
// (`?asOf=`) like any Time Machine day: a step replaces it (back/forward
// in the browser history aren't filled with every session), a jump pushes it.
//
// Once a replay has started, data requests carry `replay=1` (src/client/api.ts):
// the server then reads each dataset once for the block of days around the
// day and cuts it at each day, so stepping is fast (src/core/reference/replay.ts).
// A day opened on its own, without stepping, reads nothing after it.
//
// Play waits for the day it just stepped to: it steps again only once the
// server has answered for that day (`ready` from the feeds that matter) and
// at least the chosen interval has passed.

export interface ReplayState {
  /** A replay has started (a step or play): requests may read the replay block ahead. */
  active: boolean;
  playing: boolean;
  /** Sessions per second while playing. */
  speed: number;
  /**
   * Bar-by-bar inside the next session: charts show bars that started before
   * this instant (epoch ms); null = up to the day's close.
   */
  cursor: number | null;
  /** Why play stopped (the newest past session reached), shown by the controls. */
  stopped: string | null;
}

let state: ReplayState = { active: false, playing: false, speed: 1, cursor: null, stopped: null };
const listeners = new Set<() => void>();

function set(patch: Partial<ReplayState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const replayState = () => state;

/** True while requests may read the replay block ahead (a replay has started on a past day). */
export const replayActive = () => state.active && timeMachine().asOf !== null;

export function useReplay<T>(selector: (current: ReplayState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector({ active: false, playing: false, speed: 1, cursor: null, stopped: null }),
  );
}

// Back to live (or a new day from elsewhere): no cursor; live ends the replay.
if (typeof window !== "undefined") {
  onTimeMachineChange(() => {
    const { asOf } = timeMachine();
    if (!asOf && (state.active || state.playing)) set({ active: false, playing: false, cursor: null, stopped: null });
  });
}

// ------------------------------------------------------------------ sessions

/** The session `steps` away from the day shown (from the server's calendar around it), or null past the end / while loading. */
export function sessionAfter(steps: number): string | null {
  const { info } = timeMachine();
  if (!info?.sessions) return null;
  const list = steps > 0 ? info.sessions.after : info.sessions.before;
  const index = steps > 0 ? steps - 1 : list.length + steps;
  return list[index] ?? null;
}

/** Step the day shown `steps` sessions (negative: back). False when there is no such session (yet). */
export function stepDay(steps: number): boolean {
  const target = sessionAfter(steps);
  if (!target) {
    if (steps > 0 && timeMachine().info) set({ playing: false, stopped: "That was the newest past session: the next one is today, the live terminal." });
    return false;
  }
  set({ active: true, cursor: null, stopped: null });
  setAsOf(target, { replace: true });
  return true;
}

/** Jump to a day (YYYY-MM-DD) and keep replaying from it. */
export function jumpTo(date: string) {
  set({ active: true, cursor: null, playing: false, stopped: null });
  setAsOf(date);
}

// ------------------------------------------------------------------ bars

/** The active chart's loaded bar times and whether they are intraday (set by the chart; a daily chart steps whole sessions). */
let bars: { times: readonly number[]; intraday: boolean } | null = null;
export function setReplayBars(next: { times: readonly number[]; intraday: boolean } | null) {
  bars = next;
}

/** Reveal the next bar on an intraday chart (into the next session), or step a session on a daily one. */
export function stepBar(direction: 1 | -1) {
  const day = timeMachineDay();
  if (day === null) return;
  if (!bars?.intraday) {
    stepDay(direction);
    return;
  }
  set({ active: true, stopped: null });
  const close = sessionCloseMs(day);
  const limit = revealLimit(day, state.cursor);
  if (direction < 0) {
    if (state.cursor === null) {
      stepDay(-1);
      return;
    }
    set({ cursor: previousBarLimit(bars.times, limit, close) });
    return;
  }
  const next = nextBarLimit(bars.times, limit);
  const nextDay = sessionAfter(1);
  const nextClose = nextDay ? sessionCloseMs(Date.parse(`${nextDay}T00:00:00Z`)) : null;
  // Past the next session's last bar (or nothing more loaded): that session is done, show it as the day.
  if (next === null || nextClose === null || next > nextClose) {
    stepDay(1);
    return;
  }
  set({ cursor: next });
}

// ------------------------------------------------------------------ play

/** Feeds that must have answered for the day before play steps again (e.g. "chart", "paper"). */
const waiting = new Set<string>();
export function replayBusy(name: string, busy: boolean) {
  if (busy) waiting.add(name);
  else waiting.delete(name);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastStep = 0;

function tick() {
  timer = null;
  if (!state.playing) return;
  const { asOf, info } = timeMachine();
  const interval = stepIntervalMs(state.speed);
  // Wait for the day stepped to: the server's answer for it and the feeds that matter.
  const ready = Boolean(asOf && info && info.requested === asOf) && waiting.size === 0;
  const due = lastStep + interval - Date.now();
  if (!ready || due > 0) {
    timer = setTimeout(tick, ready ? due : 100);
    return;
  }
  lastStep = Date.now();
  if (!stepDay(1)) {
    set({ playing: false });
    return;
  }
  timer = setTimeout(tick, interval);
}

export function play() {
  if (timeMachine().asOf === null) return;
  set({ playing: true, active: true, stopped: null, cursor: null });
  lastStep = Date.now() - stepIntervalMs(state.speed);
  if (!timer) tick();
}

export function pause() {
  set({ playing: false });
  if (timer) clearTimeout(timer);
  timer = null;
}

export const togglePlay = () => (state.playing ? pause() : play());

export function setSpeed(speed: number) {
  set({ speed: (REPLAY_SPEEDS as readonly number[]).includes(speed) ? speed : 1 });
}

/** Start a replay without moving (the controls were used): later reads may cover the block. */
export const startReplay = () => !state.active && set({ active: true });
