import "server-only";

import type { ResultsResponse } from "@/contracts/api";
import { DAY_MS, istParts } from "@/core/market/session";
import { dedupeEvents } from "@/core/parsers/resultsCalendar";
import { getResultsCalendar } from "@/server/providers/resultsCalendar";

/** Show results from a week ago (recent reactions) to five weeks ahead. */
const PAST_DAYS = 7;
const FUTURE_DAYS = 35;

export async function getResultsWindow(): Promise<ResultsResponse> {
  const { available, events, fetchedAt } = await getResultsCalendar();
  const today = istParts().day;
  // Deduped here too, so a calendar cached before the parser deduped is clean immediately.
  const window = dedupeEvents(events.filter((event) => event.date >= today - PAST_DAYS * DAY_MS && event.date <= today + FUTURE_DAYS * DAY_MS));
  return { available, fetchedAt, events: window };
}
