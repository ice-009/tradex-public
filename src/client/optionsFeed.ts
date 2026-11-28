import { useEffect, useState } from "react";
import type { OptionRange, OptionsDayResponse, OptionsResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { useAsOfKey } from "@/client/timeMachine";

// The Options panel's data (issue #36): an underlying's option summaries and
// the day's cross-section, from /api/options and /api/options/day. They change
// once a day (the hub's evening F&O file), so answers are kept for the page's
// life per symbol, range and Time Machine day; the day changing reloads them.

type Loaded<T> = { status: "loading" } | { status: "failed"; error: string } | T;

const cache = new Map<string, Promise<OptionsResponse>>();
const dayCache = new Map<string, Promise<OptionsDayResponse>>();
const MAX = 40;

function remember<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = map.get(key);
  if (!pending) {
    pending = load().then(
      (answer) => {
        // A hub that couldn't answer is asked again next time the panel opens.
        if ((answer as { status: string }).status === "unavailable") map.delete(key);
        return answer;
      },
      (error) => {
        map.delete(key);
        throw error;
      },
    );
    map.set(key, pending);
    for (const old of [...map.keys()].slice(0, Math.max(0, map.size - MAX))) map.delete(old);
  }
  return pending;
}

function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> | null {
  const [state, setState] = useState<{ key: string; value: Loaded<T> } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    load().then(
      (value) => !cancelled && setState({ key, value }),
      (error: Error) => !cancelled && setState({ key, value: { status: "failed", error: error.message } }),
    );
    return () => {
      cancelled = true;
    };
    // `load` is rebuilt every render; `key` says everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return null;
  return state?.key === key ? state.value : { status: "loading" };
}

/** An underlying's option summaries (as of the Time Machine's day when set); null without a symbol. */
export function useOptions(symbol: string | null, range: OptionRange): Loaded<OptionsResponse> | null {
  const asOf = useAsOfKey();
  const key = symbol ? `${symbol}|${range}|${asOf}` : null;
  return useLoaded(key, () => remember(cache, key!, () => api.options(symbol!, range)));
}

/** Every underlying's option summary on the newest stored day (on or before the Time Machine's day). */
export function useOptionsDay(enabled: boolean): Loaded<OptionsDayResponse> | null {
  const asOf = useAsOfKey();
  const key = enabled ? asOf : null;
  return useLoaded(key, () => remember(dayCache, `day|${key}`, () => api.optionsDay()));
}
