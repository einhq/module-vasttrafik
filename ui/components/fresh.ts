/** How long past an answer's freshness a card waits, so it never asks a moment too soon and gets the same one. */
const PAST_MS = 100;

/**
 * The wait before a card asks again for an answer fresh for `freshMs` more: just after it is due, so
 * that every screen on one stop has the new answer as soon as the first to ask has made it. None for
 * an answer due already, which leaves the card's own pace.
 */
export const whenDue = (freshMs: number | undefined): number | undefined => freshMs ? freshMs + PAST_MS : undefined;
