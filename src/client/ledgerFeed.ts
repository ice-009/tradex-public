import { useCallback, useEffect, useState } from "react";
import type { PlanLedgerResponse, PlanLedgerVerifyResponse } from "@/contracts/api";
import { istParts } from "@/core/market/session";
import { SEAL_WINDOWS } from "@/core/plan/sealSchedule";
import { api } from "@/client/api";
import { useAsOfKey } from "@/client/timeMachine";

// The sealed-plan ledger (#33) for the Plan tab: the last 30 days' seals,
// re-read every few minutes, and every 30 s around the close seal so it shows
// up as soon as the server has made it. Not loaded in the Time Machine (the
// ledger is a live record; the server answers "past" there too).

const REFRESH_MS = 5 * 60_000;
const NEAR_SEAL_MS = 30_000;

/** Around the close window (3:10–3:30 PM IST), when today's seal appears. */
function nearSeal(now = Date.now()) {
  const { minutes } = istParts(now);
  return minutes >= SEAL_WINDOWS.close.from - 5 && minutes <= SEAL_WINDOWS.close.to + 5;
}

export interface LedgerFeed {
  ledger: PlanLedgerResponse | null;
  error: string | null;
  verification: PlanLedgerVerifyResponse | null;
  verifying: boolean;
  /** Check the whole chain on the server. */
  verify: () => void;
}

export function useLedgerFeed(): LedgerFeed {
  const asOf = useAsOfKey();
  const [ledger, setLedger] = useState<PlanLedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<PlanLedgerVerifyResponse | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const json = await api.planLedger();
        if (cancelled) return;
        setLedger(json);
        setError(null);
        if (json.status === "past") return;
      } catch (failure) {
        if (!cancelled) setError((failure as Error).message);
      }
      if (!cancelled) timer = setTimeout(load, nearSeal() ? NEAR_SEAL_MS : REFRESH_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [asOf]);

  const verify = useCallback(() => {
    setVerifying(true);
    api
      .verifyPlanLedger()
      .then(setVerification)
      .catch((failure: Error) => setVerification({ status: "error", error: failure.message }))
      .finally(() => setVerifying(false));
  }, []);

  return { ledger, error, verification, verifying, verify };
}
