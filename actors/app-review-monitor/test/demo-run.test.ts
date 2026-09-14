/**
 * The zero-config demo run must NEVER return an empty dataset.
 *
 * Apify runs the default input every day and requires a non-empty result; three
 * failures earn a public "Under Maintenance" label and 28 more days deprecates
 * the Actor. A monitor whose whole value is "only what is new" returns nothing
 * on day 2 once its state remembers day 1 — so the demo run, and only the demo
 * run, keeps its state in the run's own store and is therefore always a first
 * run. These tests pin both halves of that: the demo never goes quiet, and a
 * configured run still de-duplicates exactly as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { Actor } from 'apify';

import { buildCheckList } from '../src/detect.ts';
import { selectNewReviews } from '../src/incremental.ts';
import {
    DEFAULT_APPS,
    DEFAULT_MAX_REVIEWS_PER_APP,
    DEMO_MAX_REVIEWS_PER_APP,
    isZeroConfigRun,
    parseInput,
    type RawInput,
} from '../src/input.ts';
import { SeenStore, stateStoreNameFor } from '../src/state.ts';
import { buildRunNote } from '../src/outcome.ts';
import type { ReviewRow } from '../src/types.ts';

/** An in-memory stand-in for a key-value store. */
function makeFakeKv() {
    const values = new Map<string, unknown>();
    return {
        values,
        // eslint-disable-next-line @typescript-eslint/require-await
        async getValue(key: string) {
            return values.get(key) ?? null;
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async setValue(key: string, value: unknown) {
            if (value === null) values.delete(key);
            else values.set(key, value);
        },
    };
}

/**
 * Stand in for the platform's stores.
 *
 * A NAMED store is shared across runs, exactly like the real thing. The run's
 * own default store (opened with no name) is created fresh on every call, which
 * is what makes it ephemeral — that asymmetry is the behaviour under test.
 */
function installFakeStores() {
    const named = new Map<string, ReturnType<typeof makeFakeKv>>();
    let defaultStoresOpened = 0;

    mock.method(Actor, 'openKeyValueStore', async (name?: string) => {
        if (name === undefined || name === null) {
            defaultStoresOpened += 1;
            return makeFakeKv() as never;
        }
        let store = named.get(name);
        if (store === undefined) {
            store = makeFakeKv();
            named.set(name, store);
        }
        return store as never;
    });

    return { named, defaultStoresOpened: () => defaultStoresOpened };
}

function review(id: string): ReviewRow {
    return {
        store: 'google-play',
        appId: 'dev.astraedus.nudge',
        appName: 'Nudge',
        country: 'us',
        reviewId: id,
        rating: 5,
        title: null,
        text: `review ${id}`,
        author: 'Sam',
        date: '2026-09-12T04:31:00.000Z',
        appVersion: '1.17.0',
        developerReply: null,
        url: 'https://play.google.com/store/apps/details?id=dev.astraedus.nudge',
        isNew: true,
    };
}

/**
 * One run of the Actor's incremental core, wired exactly as main.ts wires it:
 * pick the store, read what was seen, select, persist. The only thing faked is
 * the network fetch and the platform storage.
 */
async function simulateRun(raw: RawInput, fetched: readonly ReviewRow[]): Promise<ReviewRow[]> {
    const input = parseInput(raw);
    const store = await SeenStore.open(stateStoreNameFor(input));
    const [check] = buildCheckList([fetched[0]!.appId], [fetched[0]!.country]);
    const seen = await store.get(check!.store, check!.appId, check!.country);
    const selection = selectNewReviews(fetched, seen, {
        onlyNew: input.onlyNew,
        maxReviews: input.maxReviewsPerApp,
    });
    await store.set(check!.store, check!.appId, check!.country, selection.nextSeen);
    return selection.emitted;
}

test('the zero-config demo run keeps NO state, so two runs in a row both emit rows', async (t) => {
    const stores = installFakeStores();
    t.after(() => mock.restoreAll());

    const fetched = [review('r1'), review('r2'), review('r3')];

    const first = await simulateRun({}, fetched);
    const second = await simulateRun({}, fetched);

    assert.equal(first.length, 3, 'the first demo run must emit the baseline');
    assert.equal(
        second.length,
        3,
        'the second demo run must ALSO emit rows — an empty dataset here is what earns "Under Maintenance"',
    );
    assert.deepEqual(
        second.map((r) => r.reviewId),
        ['r1', 'r2', 'r3'],
    );
    assert.equal(stores.defaultStoresOpened(), 2, 'each demo run must get its own fresh store');
    assert.equal(stores.named.size, 0, 'a demo run must never touch the shared named store');
});

test('a configured run still de-duplicates across runs, which is the actual product', async (t) => {
    installFakeStores();
    t.after(() => mock.restoreAll());

    const configured = { apps: ['dev.astraedus.nudge'] };
    const first = await simulateRun(configured, [review('r1'), review('r2')]);
    const second = await simulateRun(configured, [review('r1'), review('r2')]);
    const third = await simulateRun(configured, [review('r1'), review('r2'), review('r3')]);

    assert.equal(first.length, 2, 'first run emits the baseline');
    assert.equal(second.length, 0, 'nothing new means nothing emitted');
    assert.deepEqual(
        third.map((r) => r.reviewId),
        ['r3'],
        'only the genuinely new review is emitted',
    );
});

test('a configured run persists into the NAMED store, a demo run into neither', async (t) => {
    const stores = installFakeStores();
    t.after(() => mock.restoreAll());

    await simulateRun({ apps: ['dev.astraedus.nudge'] }, [review('r1')]);
    assert.deepEqual([...stores.named.keys()], ['app-review-monitor-state']);
    assert.ok(
        [...stores.named.get('app-review-monitor-state')!.values.keys()].some((k) => k.startsWith('seen-')),
        'the named store must hold the seen-id record',
    );

    await simulateRun({}, [review('r1')]);
    assert.equal(stores.named.size, 1, 'the demo run must not create or write another named store');
});

test('stateStoreNameFor routes the demo to the run-scoped store and everyone else to the named one', () => {
    assert.equal(stateStoreNameFor({ isDemoRun: true, stateStoreName: 'whatever' }), null);
    assert.equal(stateStoreNameFor({ isDemoRun: false, stateStoreName: 'my-store' }), 'my-store');
});

test('GUARD: only an untouched input is a demo run', () => {
    assert.equal(parseInput({}).isDemoRun, true, 'an empty input is the demo');
    assert.equal(
        parseInput({
            apps: [...DEFAULT_APPS],
            countries: ['us'],
            maxReviewsPerApp: DEFAULT_MAX_REVIEWS_PER_APP,
            onlyNew: true,
            stateStoreName: 'app-review-monitor-state',
        }).isDemoRun,
        true,
        'the platform materialises the input-schema defaults into INPUT, so the fully-defaulted '
            + 'object must be recognised as the demo too — this is the case a naive "is `apps` absent?" '
            + 'check would get wrong on every real platform run',
    );

    // Changing any single output-shaping field opts into the real product.
    const configured: Array<[string, RawInput]> = [
        ['own apps', { apps: ['com.example.app'] }],
        ['extra app', { apps: [...DEFAULT_APPS, 'com.example.app'] }],
        ['another country', { countries: ['gb'] }],
        ['a different cap', { maxReviewsPerApp: 50 }],
        ['full re-export', { onlyNew: false }],
        ['a rating filter', { minRating: 4 }],
        ['a max-rating filter', { maxRating: 2 }],
        ['their own state store', { stateStoreName: 'my-monitor' }],
    ];
    for (const [label, raw] of configured) {
        assert.equal(parseInput(raw).isDemoRun, false, `${label} must NOT be treated as a demo run`);
        assert.equal(
            stateStoreNameFor(parseInput(raw)) !== null,
            true,
            `${label} must keep persistent cross-run state`,
        );
    }
});

test('the demo app order does not matter, but the demo cap does', () => {
    const shuffled = [...DEFAULT_APPS].reverse();
    assert.equal(parseInput({ apps: shuffled }).isDemoRun, true);

    const demo = parseInput({});
    assert.equal(demo.maxReviewsPerApp, DEMO_MAX_REVIEWS_PER_APP);
    assert.ok(
        DEMO_MAX_REVIEWS_PER_APP < DEFAULT_MAX_REVIEWS_PER_APP,
        'a demo re-emits its baseline every run, so it must be capped below the configured default',
    );
    assert.equal(parseInput({ apps: ['com.example.app'] }).maxReviewsPerApp, DEFAULT_MAX_REVIEWS_PER_APP);
});

test('the demo cap is actually enforced on the emitted rows', async (t) => {
    installFakeStores();
    t.after(() => mock.restoreAll());

    const many = Array.from({ length: DEMO_MAX_REVIEWS_PER_APP + 25 }, (_, i) => review(`r${i}`));
    const emitted = await simulateRun({}, many);
    assert.equal(emitted.length, DEMO_MAX_REVIEWS_PER_APP);
});

test('GUARD: the non-empty guarantee does not depend on Apple', () => {
    // Apple's public RSS feed refuses to serve data often enough that it cannot
    // be the only thing standing between us and an empty daily test — it did
    // exactly that on 2026-09-14. Google Play alone must carry the demo.
    const parsed = parseInput(null);
    const checks = buildCheckList(parsed.apps, parsed.countries);
    const googlePlay = checks.filter((c) => c.store === 'google-play');
    const apple = checks.filter((c) => c.store === 'app-store');

    assert.ok(
        googlePlay.length >= 2,
        'the default apps must include at least two Google Play targets, so one app with no reviews '
            + 'yet still leaves another that can carry the run',
    );
    assert.ok(apple.length >= 1, 'the default input must still exercise the Apple code path');
});

test('the run note tells a demo reader why nothing is remembered', () => {
    const note = buildRunNote(4, 3, [], [], { demoRun: true });
    assert.match(note, /demo run/i);
    assert.match(note, /discarded when the run ends/i);
    assert.match(note, /`apps`/);

    const real = buildRunNote(4, 3, [], []);
    assert.doesNotMatch(real, /demo run/i, 'a configured run must not claim to be a demo');
});
