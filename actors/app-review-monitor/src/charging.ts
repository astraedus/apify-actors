/**
 * Pay-per-event charging.
 *
 * Two events, both defined in `.actor/pay_per_event.json` (our manifest) and
 * priced in Apify Console:
 *   - `app-checked`    $0.010  once per app+country per run
 *   - `review-emitted` $0.002  once per row pushed to the dataset
 *
 * `Actor.charge()` throws on an Actor that is not configured for PPE — which is
 * exactly the state of a local `apify run` unless `ACTOR_TEST_PAY_PER_EVENT=true`
 * is set. Every charge therefore goes through `chargeSafely`, which downgrades a
 * charging failure to a warning: a customer must never lose a finished scrape
 * because the billing call hiccuped.
 */

import { Actor, log } from 'apify';

export const EVENT_APP_CHECKED = 'app-checked';
export const EVENT_REVIEW_EMITTED = 'review-emitted';

/** Every event this Actor can charge. Asserted against the manifest in tests. */
export const CHARGEABLE_EVENTS = [EVENT_APP_CHECKED, EVENT_REVIEW_EMITTED] as const;
export type ChargeableEvent = (typeof CHARGEABLE_EVENTS)[number];

/**
 * Charge `count` occurrences of an event, never throwing.
 * Returns the number the platform actually billed (0 when charging is off).
 */
export async function chargeSafely(eventName: ChargeableEvent, count = 1): Promise<number> {
    if (count <= 0) return 0;
    try {
        const result = await Actor.charge({ eventName, count });
        return result?.chargedCount ?? 0;
    } catch (error) {
        log.debug(`Charging "${eventName}" x${count} failed: ${(error as Error).message}`);
        return 0;
    }
}

/**
 * How many more `review-emitted` events the user's spending limit allows.
 * `Infinity` when there is no limit, or when the charging manager is unavailable
 * (local runs) — the caller then relies on `maxReviewsPerApp` alone.
 */
export async function remainingReviewBudget(): Promise<number> {
    try {
        const manager = Actor.getChargingManager();
        const remaining = manager.calculateMaxEventChargeCountWithinLimit(EVENT_REVIEW_EMITTED);
        return typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : Infinity;
    } catch {
        return Infinity;
    }
}
