import { useEffect, useState } from "react";
import type { ApiUsageResponse } from "@/contracts/api";
import { api } from "@/client/api";

/** Broker API usage, re-read every `everyMs` while mounted (null until the first answer). */
export function useApiUsage(everyMs = 60_000): ApiUsageResponse | null {
  const [usage, setUsage] = useState<ApiUsageResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .usage()
        .then((value) => !cancelled && setUsage(value))
        .catch(() => {});
    void load();
    const timer = setInterval(load, everyMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [everyMs]);
  return usage;
}
