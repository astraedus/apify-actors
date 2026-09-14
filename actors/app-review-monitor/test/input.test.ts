import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCheckList } from '../src/detect.ts';
import {
    DEFAULT_APPS,
    DEFAULT_COUNTRIES,
    DEFAULT_MAX_REVIEWS_PER_APP,
    MAX_REVIEWS_LIMIT,
    parseInput,
} from '../src/input.ts';
import { DEFAULT_STATE_STORE_NAME } from '../src/state.ts';

test('a completely empty input yields the documented zero-config defaults', () => {
    for (const empty of [null, undefined, {}]) {
        const parsed = parseInput(empty);
        assert.deepEqual(parsed.apps, [...DEFAULT_APPS]);
        assert.deepEqual(parsed.countries, [...DEFAULT_COUNTRIES]);
        assert.equal(parsed.maxReviewsPerApp, DEFAULT_MAX_REVIEWS_PER_APP);
        assert.equal(parsed.onlyNew, true);
        assert.equal(parsed.minRating, null);
        assert.equal(parsed.maxRating, null);
        assert.equal(parsed.webhookUrl, null);
        assert.equal(parsed.stateStoreName, DEFAULT_STATE_STORE_NAME);
        assert.equal(parsed.resetState, false);
    }
});

test('GUARD: the default input exercises BOTH stores and resolves cleanly', () => {
    // Apify runs an automated test on the default input daily; if it stops
    // producing a valid check list, the actor gets an "Under Maintenance" label.
    const parsed = parseInput(null);
    const checks = buildCheckList(parsed.apps, parsed.countries);
    assert.equal(checks.length, DEFAULT_APPS.length);
    const stores = new Set(checks.map((c) => c.store));
    assert.ok(stores.has('google-play'), 'default input must exercise Google Play');
    assert.ok(stores.has('app-store'), 'default input must exercise the App Store');
});

test('GUARD: the defaults include a high-volume app so a scheduled default run is never empty', () => {
    // Our own apps get a handful of reviews a week; with onlyNew=true the daily
    // automated run would return zero rows most days and look broken. Facebook
    // (284882215) collects new US reviews continuously.
    assert.ok(DEFAULT_APPS.includes('284882215'));
});

test('onlyNew defaults to true but false is respected', () => {
    assert.equal(parseInput({ onlyNew: false }).onlyNew, false);
    assert.equal(parseInput({ onlyNew: true }).onlyNew, true);
    assert.equal(parseInput({ onlyNew: undefined }).onlyNew, true);
});

test('countries are lower-cased so US and us are the same storefront', () => {
    assert.deepEqual(parseInput({ countries: ['US', 'Gb'] }).countries, ['us', 'gb']);
});

test('a comma or newline separated paste is accepted for list fields', () => {
    assert.deepEqual(parseInput({ apps: 'com.whatsapp, 284882215' }).apps, ['com.whatsapp', '284882215']);
    assert.deepEqual(parseInput({ countries: 'us\ngb\n' }).countries, ['us', 'gb']);
});

test('an empty list falls back to the defaults instead of checking nothing', () => {
    assert.deepEqual(parseInput({ apps: [] }).apps, [...DEFAULT_APPS]);
    assert.deepEqual(parseInput({ countries: [] }).countries, [...DEFAULT_COUNTRIES]);
});

test('maxReviewsPerApp is clamped to the documented ceiling and floored to an integer', () => {
    assert.equal(parseInput({ maxReviewsPerApp: 50 }).maxReviewsPerApp, 50);
    assert.equal(parseInput({ maxReviewsPerApp: 99999 }).maxReviewsPerApp, MAX_REVIEWS_LIMIT);
    assert.equal(parseInput({ maxReviewsPerApp: 10.9 }).maxReviewsPerApp, 10);
    assert.equal(parseInput({ maxReviewsPerApp: '25' }).maxReviewsPerApp, 25);
});

test('a nonsensical maxReviewsPerApp fails loudly before any charge happens', () => {
    assert.throws(() => parseInput({ maxReviewsPerApp: 0 }), /positive number/);
    assert.throws(() => parseInput({ maxReviewsPerApp: -5 }), /positive number/);
    assert.throws(() => parseInput({ maxReviewsPerApp: 'lots' }), /positive number/);
});

test('rating filters accept 1-5 and reject anything else', () => {
    assert.equal(parseInput({ minRating: 3 }).minRating, 3);
    assert.equal(parseInput({ maxRating: '2' }).maxRating, 2);
    assert.equal(parseInput({ minRating: '' }).minRating, null);
    assert.throws(() => parseInput({ minRating: 0 }), /between 1 and 5/);
    assert.throws(() => parseInput({ maxRating: 6 }), /between 1 and 5/);
    assert.throws(() => parseInput({ minRating: 'bad' }), /between 1 and 5/);
});

test('an inverted rating window is rejected rather than silently emitting nothing', () => {
    assert.throws(() => parseInput({ minRating: 4, maxRating: 2 }), /cannot be greater than/);
    // The degenerate single-value window is legitimate.
    assert.doesNotThrow(() => parseInput({ minRating: 3, maxRating: 3 }));
});

test('webhookUrl is validated as an http(s) URL', () => {
    assert.equal(parseInput({ webhookUrl: 'https://example.com/hook' }).webhookUrl, 'https://example.com/hook');
    assert.equal(parseInput({ webhookUrl: '' }).webhookUrl, null);
    assert.throws(() => parseInput({ webhookUrl: 'not-a-url' }), /not a valid URL/);
    assert.throws(() => parseInput({ webhookUrl: 'ftp://example.com' }), /must be an http\(s\) URL/);
});

test('too many apps in one run is refused with a clear limit', () => {
    const many = Array.from({ length: 101 }, (_, i) => `com.example.app${i}`);
    assert.throws(() => parseInput({ apps: many }), /limited to 100 entries/);
});

test('a blank stateStoreName falls back to the default rather than an empty store name', () => {
    assert.equal(parseInput({ stateStoreName: '   ' }).stateStoreName, DEFAULT_STATE_STORE_NAME);
    assert.equal(parseInput({ stateStoreName: 'my-store' }).stateStoreName, 'my-store');
});

test('GUARD: every default app is a shape the detector actually understands', () => {
    for (const app of DEFAULT_APPS) {
        assert.doesNotThrow(() => buildCheckList([app], ['us']), `default app "${app}" is unparseable`);
    }
});
