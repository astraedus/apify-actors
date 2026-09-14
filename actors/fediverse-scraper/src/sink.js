/**
 * Dataset sink: de-duplication, batched pushes, and pay-per-event charging.
 *
 * Charging is deliberately fused to the push. `Actor.pushData(rows, eventName)` stores
 * and bills in one call and reports back whether the user's spending limit is now
 * exhausted, so a row can never be delivered-but-unbilled or billed-but-undelivered.
 *
 * Pricing itself is NOT declared here or in actor.json -- Apify only accepts pay-per-event
 * prices through the Console monetization wizard. `.actor/pricing.json` records the prices
 * this Actor is published with so the repo, the README and the Console cannot silently
 * drift apart; EVENT_NAMES below must match what is typed into that wizard, because
 * charging an event the Console does not know about is an error.
 */

/** Must match the event names configured in the Apify Console. */
export const EVENT_PROFILE = 'profile-scraped';
export const EVENT_POST = 'post-scraped';

const DEFAULT_BATCH_SIZE = 50;
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_BASE_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const eventNameForRow = (row) => (row.type === 'profile' ? EVENT_PROFILE : EVENT_POST);

/**
 * Decide up front whether this run should charge, from the Actor's own pricing info.
 *
 * Answering this before the first push is what lets #flush treat every push error as a
 * real error. Charging is enabled only when the Actor is actually configured pay-per-event
 * AND both event names exist in its pricing -- charging an unconfigured event is an error,
 * and silently mis-billing is worse than not billing.
 *
 * @param {{isPayPerEvent?: boolean, perEventPrices?: Record<string, number>}|null} pricingInfo
 * @returns {{charge: boolean, reason: string}}
 */
export function decideCharging(pricingInfo, { isAtHome }) {
    if (!isAtHome) return { charge: false, reason: 'running locally; rows are stored but not billed' };
    if (!pricingInfo?.isPayPerEvent) {
        return { charge: false, reason: 'Actor is not configured pay-per-event; rows are stored but not billed' };
    }
    const prices = pricingInfo.perEventPrices ?? {};
    const missing = [EVENT_PROFILE, EVENT_POST].filter((name) => !(name in prices));
    if (missing.length > 0) {
        return {
            charge: false,
            reason: `pricing is missing event(s) ${missing.join(', ')}; rows are stored but not billed`,
        };
    }
    return { charge: true, reason: 'pay-per-event pricing is configured' };
}

/** Stable identity for a row, so the same post reached via two targets bills once. */
export const rowKey = (row) => `${row.platform}:${row.type}:${row.id}`;

export class RowSink {
    /**
     * @param {object} options
     * @param {(rows: object[], eventName?: string) => Promise<any>} options.pushData
     * @param {object} options.log
     * @param {boolean} [options.charge] False for local runs and for a build that is not
     *   monetized yet; rows are still stored, just not billed.
     */
    constructor({ pushData, log, charge = true, batchSize = DEFAULT_BATCH_SIZE, retryBaseMs = PUSH_RETRY_BASE_MS }) {
        this.pushData = pushData;
        this.log = log;
        this.charge = charge;
        this.batchSize = batchSize;
        this.retryBaseMs = retryBaseMs;
        this.seen = new Set();
        /** Buffered per event name -- one push per name so the charge count is right. */
        this.buffers = new Map();
        this.counts = { [EVENT_PROFILE]: 0, [EVENT_POST]: 0 };
        this.duplicates = 0;
        this.limitReached = false;
    }

    get total() {
        return this.counts[EVENT_PROFILE] + this.counts[EVENT_POST];
    }

    /**
     * Queue a row for delivery.
     *
     * @returns {Promise<boolean>} false when the row was a duplicate or the spending
     *   limit has been reached, so callers do not count it toward a per-target quota.
     */
    async emit(row) {
        if (this.limitReached) return false;
        const key = rowKey(row);
        if (this.seen.has(key)) {
            this.duplicates += 1;
            return false;
        }
        this.seen.add(key);

        const eventName = eventNameForRow(row);
        const buffer = this.buffers.get(eventName) ?? [];
        buffer.push(row);
        this.buffers.set(eventName, buffer);

        if (buffer.length >= this.batchSize) await this.#flush(eventName);
        return true;
    }

    /**
     * Push one buffered batch, retrying transient failures.
     *
     * Whether to charge is decided ONCE before the run starts, from the Actor's pricing
     * info -- never inferred from a failed push. Treating any error as "not monetized"
     * would let a single transient 5xx silently downgrade the rest of the run to free
     * delivery, and re-pushing rows that may already have been stored would duplicate
     * them. So a push that keeps failing fails the run instead of quietly giving data away.
     */
    async #flush(eventName) {
        const rows = this.buffers.get(eventName);
        if (!rows?.length) return;
        this.buffers.set(eventName, []);

        let lastError;
        for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
            try {
                const result = this.charge
                    ? await this.pushData(rows, eventName)
                    : await this.pushData(rows);
                this.counts[eventName] += rows.length;
                if (result?.eventChargeLimitReached) {
                    this.limitReached = true;
                    this.log.warning(
                        `Reached the run's maximum total charge after ${this.total} items. `
                        + 'Stopping early; raise the limit on the run to collect more.',
                    );
                }
                return;
            } catch (error) {
                lastError = error;
                if (attempt === PUSH_ATTEMPTS) break;
                const delay = this.retryBaseMs * 2 ** (attempt - 1);
                this.log.warning(
                    `Storing ${rows.length} "${eventName}" row(s) failed (${error.message}); `
                    + `retrying in ${delay}ms (attempt ${attempt}/${PUSH_ATTEMPTS}).`,
                );
                await sleep(delay);
            }
        }
        // Deliberately fatal: continuing would either lose the rows or hand them over unbilled.
        throw new Error(
            `Failed to store ${rows.length} "${eventName}" row(s) after ${PUSH_ATTEMPTS} attempts: ${lastError?.message}`,
        );
    }

    /** Push whatever is still buffered. Always call before the run exits. */
    async flushAll() {
        for (const eventName of [...this.buffers.keys()]) {
            await this.#flush(eventName);
        }
    }
}
