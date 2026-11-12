import "server-only";

import type { ResultsResponse } from "@/contracts/api";
import { DAY_MS, istParts } from "@/core/market/session";
import { getResultsCalendar } from "@/server/providers/reference";

/** Show results from a week ago (recent reactions) to five weeks ahead. */
const PAST_DAYS = 7;
const FUTURE_DAYS = 35;

export async function getResultsWindow(): Promise<ResultsResponse> {
  const { available, events, fetchedAt } = await getResultsCalendar();
  const today = istParts().day;
  return { available, fetchedAt, events: events.filter((event) => event.date >= today - PAST_DAYS * DAY_MS && event.date <= today + FUTURE_DAYS * DAY_MS) };
}
