// Links to the report cards (#23), for the Lab tab and the cards themselves.

/** /lab/<signal>[?variant=<variant key>]: signal ids hold ":" (screen:<id>), so both are encoded. */
export const cardHref = (signalId: string, variantKey?: string) => `/lab/${encodeURIComponent(signalId)}${variantKey ? `?variant=${encodeURIComponent(variantKey)}` : ""}`;
