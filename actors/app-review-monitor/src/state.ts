/**
 * Cross-run state: which review ids have already been emitted, per app+country.
 *
 * Stored in a NAMED key-value store (default `app-review-monitor-state`) rather
 * than the run's default store, because the default store belongs to a single
 * run and is useless for "what did yesterday's scheduled run already see".
 */

import { Actor, log } from 'apify';
import type { KeyValueStore } from 'apify';
import type { Store } from './detect.ts';

export const DEFAULT_STATE_STORE_NAME = 'app-review-monitor-state';

interface SeenRecord {
    /** Most-recent-first review ids. */
    ids: string[];
    /** ISO-8601 of the run that wrote this record; informational only. */
    updatedAt: string;
}

/**
 * Key-value store keys allow `[a-zA-Z0-9!\-_.'()]`; Play package names and
 * Apple ids are already inside that set, but a hostile input might not be.
 */
function safeKey(store: Store, appId: string, country: string): string {
    const cleaned = appId.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_');
    return `seen-${store}-${cleaned}-${country}`;
}

export class SeenStore {
    readonly #kv: KeyValueStore;
    readonly #readOnly: boolean;

    private constructor(kv: KeyValueStore, readOnly: boolean) {
        this.#kv = kv;
        this.#readOnly = readOnly;
    }

    static async open(storeName: string, readOnly = false): Promise<SeenStore> {
        const kv = await Actor.openKeyValueStore(storeName);
        return new SeenStore(kv, readOnly);
    }

    async get(store: Store, appId: string, country: string): Promise<string[]> {
        const record = await this.#kv.getValue<SeenRecord>(safeKey(store, appId, country));
        if (!record || !Array.isArray(record.ids)) return [];
        return record.ids.filter((id): id is string => typeof id === 'string');
    }

    async set(store: Store, appId: string, country: string, ids: readonly string[]): Promise<void> {
        if (this.#readOnly) return;
        const record: SeenRecord = { ids: [...ids], updatedAt: new Date().toISOString() };
        await this.#kv.setValue(safeKey(store, appId, country), record);
    }

    /** Forget one app+country so the next run treats it as a first run. */
    async reset(store: Store, appId: string, country: string): Promise<void> {
        if (this.#readOnly) return;
        await this.#kv.setValue(safeKey(store, appId, country), null);
        log.info(`State reset for ${store}/${appId}/${country}.`);
    }
}
