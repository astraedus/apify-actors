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

/**
 * Which key-value store this run should keep its seen-review ids in.
 *
 * `null` means the run's own default store, i.e. no memory between runs. Pulled
 * out of main.ts as a pure function so the choice that decides whether a run can
 * ever return an empty dataset is unit-tested rather than trusted.
 */
export function stateStoreNameFor(input: { isDemoRun: boolean; stateStoreName: string }): string | null {
    return input.isDemoRun ? null : input.stateStoreName;
}

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

    /**
     * Open the store holding the seen-review ids.
     *
     * `storeName: null` opens the RUN'S OWN default key-value store, which is
     * created fresh for every run and thrown away with it. That is ephemeral by
     * construction, so a run using it always behaves like a first run. It is
     * what the zero-config demo uses, so that pressing Start — or Apify's daily
     * reliability test, which requires a non-empty dataset — returns reviews on
     * day 100 exactly as it did on day 1. Real callers pass a name and keep the
     * named store, which is the whole point of an incremental monitor.
     */
    static async open(storeName: string | null, readOnly = false): Promise<SeenStore> {
        const kv = storeName === null
            ? await Actor.openKeyValueStore()
            : await Actor.openKeyValueStore(storeName);
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
