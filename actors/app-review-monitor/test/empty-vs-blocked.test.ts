/**
 * Regression tests for the failure mode measured on 2026-09-14: Apple's public
 * review feed began answering HTTP 200 with an empty envelope for EVERY app
 * after roughly a dozen rapid requests. Reported naively that is "this app has
 * no reviews" — a silent lie to a paying customer, and an alert that can never
 * fire.
 *
 * The contract under test: an empty result means "no reviews" ONLY when a second,
 * independent source agrees the app has no ratings. Otherwise it is an error
 * that names the real cause.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AppleAppNotFoundError,
    AppleFeedUnavailableError,
    fetchAppleReviews,
    parseAppleLookup,
} from '../src/sources/apple.ts';
import { parseGooglePlayAppMeta } from '../src/sources/google-play.ts';

/** The empty envelope Apple serves while throttling — captured live, trimmed. */
const THROTTLED_FEED = {
    feed: {
        author: { name: { label: 'iTunes Store' } },
        title: { label: 'iTunes Store: Customer Reviews' },
        link: [
            { attributes: { rel: 'alternate', href: 'https://music.apple.com/' } },
            { attributes: { rel: 'last', href: '' } },
            { attributes: { rel: 'next', href: '' } },
        ],
    },
};

const lookupFor = (overrides: Record<string, unknown> | null) => ({
    resultCount: overrides ? 1 : 0,
    results: overrides ? [overrides] : [],
});

/** Stub global fetch with a router keyed on URL substrings. */
function withFetch<T>(routes: Array<[string, unknown]>, body: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);
        const match = routes.find(([fragment]) => url.includes(fragment));
        if (!match) throw new Error(`unrouted fetch: ${url}`);
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => match[1],
        } as Response;
    }) as typeof fetch;
    return body().finally(() => {
        globalThis.fetch = original;
    });
}

test('parseAppleLookup reads the rating count, treating an absent count as zero', () => {
    assert.deepEqual(parseAppleLookup(lookupFor({ trackName: 'Facebook', userRatingCount: 28304783 })), {
        exists: true,
        name: 'Facebook',
        ratingCount: 28304783,
    });
    // Apple omits userRatingCount entirely for an app nobody has rated.
    assert.deepEqual(parseAppleLookup(lookupFor({ trackName: 'Tiny App' })), {
        exists: true,
        name: 'Tiny App',
        ratingCount: 0,
    });
    assert.deepEqual(parseAppleLookup(lookupFor(null)), { exists: false, name: null, ratingCount: 0 });
    assert.deepEqual(parseAppleLookup(null), { exists: false, name: null, ratingCount: 0 });
});

test('REGRESSION: an empty feed for an app with millions of ratings is an error, not "no reviews"', async () => {
    await withFetch(
        [
            ['/lookup', lookupFor({ trackName: 'Facebook', userRatingCount: 28304783 })],
            ['/rss/customerreviews', THROTTLED_FEED],
        ],
        async () => {
            await assert.rejects(
                () => fetchAppleReviews('284882215', 'us', 200),
                (error: Error) => {
                    assert.ok(error instanceof AppleFeedUnavailableError);
                    // The message must name the real cause and exonerate the user's input.
                    assert.match(error.message, /rate-limiting or temporarily unavailable/);
                    assert.match(error.message, /28,304,783 ratings/);
                    return true;
                },
            );
        },
    );
});

test('an app that genuinely has no ratings returns an empty list, not an error', async () => {
    await withFetch(
        [
            ['/lookup', lookupFor({ trackName: 'Brand New App' })],
            ['/rss/customerreviews', THROTTLED_FEED],
        ],
        async () => {
            const result = await fetchAppleReviews('1611425753', 'us', 200);
            assert.deepEqual(result.reviews, []);
            assert.equal(result.appName, 'Brand New App');
        },
    );
});

test('an app id that does not exist in the storefront gets its own message', async () => {
    await withFetch(
        [
            ['/lookup', lookupFor(null)],
            ['/rss/customerreviews', THROTTLED_FEED],
        ],
        async () => {
            await assert.rejects(
                () => fetchAppleReviews('999999999999', 'us', 200),
                (error: Error) => {
                    assert.ok(error instanceof AppleAppNotFoundError);
                    assert.match(error.message, /No app with ID 999999999999/);
                    assert.match(error.message, /"us"/);
                    return true;
                },
            );
        },
    );
});

test('the three empty-result causes produce three DIFFERENT messages', async () => {
    // The whole point: an operator reading the run log must be able to tell
    // "your input is wrong" from "Apple is blocking us" from "nothing to report".
    const messages: string[] = [];

    await withFetch(
        [['/lookup', lookupFor(null)], ['/rss/customerreviews', THROTTLED_FEED]],
        async () => {
            await fetchAppleReviews('1', 'us', 10).catch((e: Error) => messages.push(e.message));
        },
    );
    await withFetch(
        [['/lookup', lookupFor({ trackName: 'X', userRatingCount: 500 })], ['/rss/customerreviews', THROTTLED_FEED]],
        async () => {
            await fetchAppleReviews('2', 'us', 10).catch((e: Error) => messages.push(e.message));
        },
    );

    assert.equal(messages.length, 2);
    assert.notEqual(messages[0], messages[1]);
    assert.equal(new Set(messages).size, 2);
});

test('a healthy feed still parses normally through the same code path', async () => {
    const healthy = {
        feed: {
            entry: [
                {
                    id: { label: 'r1' },
                    'im:rating': { label: '4' },
                    title: { label: 'Good' },
                    content: { label: 'Works well' },
                    author: { name: { label: 'someone' } },
                    updated: { label: '2026-09-12T21:23:20-07:00' },
                    'im:version': { label: '1.2.3' },
                },
            ],
        },
    };
    await withFetch(
        [
            ['/lookup', lookupFor({ trackName: 'Facebook', userRatingCount: 28304783 })],
            ['/rss/customerreviews', healthy],
        ],
        async () => {
            const { reviews, appName } = await fetchAppleReviews('284882215', 'us', 200);
            assert.equal(appName, 'Facebook');
            assert.equal(reviews.length, 1);
            assert.equal(reviews[0]!.reviewId, 'r1');
            assert.equal(reviews[0]!.rating, 4);
        },
    );
});

test('parseGooglePlayAppMeta treats a missing review count as unknown, never as zero', () => {
    // Play hides the count for low-volume apps, and those apps DO have reviews —
    // Nudge reports no count yet returns reviews. Reading absent as zero would
    // wrongly flag every small app as broken.
    assert.deepEqual(parseGooglePlayAppMeta({ title: 'WhatsApp Messenger', reviews: 1952171 }), {
        name: 'WhatsApp Messenger',
        reviewCount: 1952171,
    });
    assert.deepEqual(parseGooglePlayAppMeta({ title: 'Nudge - ADHD App Blocker' }), {
        name: 'Nudge - ADHD App Blocker',
        reviewCount: null,
    });
    assert.deepEqual(parseGooglePlayAppMeta({}), { name: null, reviewCount: null });
    assert.deepEqual(parseGooglePlayAppMeta(null), { name: null, reviewCount: null });
});
