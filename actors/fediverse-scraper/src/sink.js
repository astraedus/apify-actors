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

export const eventNameForRow = (row) => (row.type === 'profile' ? EVENT_PROFILE : EVENT_POST);

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
    constructor({ pushData, log, charge = true, batchSize = DEFAULT_BATCH_SIZE }) {
        this.pushData = pushData;
        this.log = log;
        this.charge = charge;
        this.batchSize = batchSize;
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

    async #flush(eventName) {
        const rows = this.buffers.get(eventName);
        if (!rows?.length) return;
        this.buffers.set(eventName, []);

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
        } catch (error) {
            // A build that has not been monetized yet rejects the event name. Storing the
            // data still succeeded or must still be attempted -- never lose rows over billing.
            if (this.charge) {
                this.charge = false;
                this.log.warning(
                    `Charging "${eventName}" failed (${error.message}). `
                    + 'Continuing without charging -- this is expected for a build that is not monetized yet.',
                );
                await this.pushData(rows);
                this.counts[eventName] += rows.length;
                return;
            }
            throw error;
        }
    }

    /** Push whatever is still buffered. Always call before the run exits. */
    async flushAll() {
        for (const eventName of [...this.buffers.keys()]) {
            await this.#flush(eventName);
        }
    }
}
