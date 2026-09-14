import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_SEEN_IDS,
    applyRatingFilter,
    averageRating,
    lowestRated,
    passesRatingFilter,
    selectNewReviews,
} from '../src/incremental.ts';

const r = (reviewId: string, rating: number | null = 5) => ({ reviewId, rating });

test('first run emits everything up to the cap and records a baseline', () => {
    const fetched = [r('a'), r('b'), r('c')];
    const result = selectNewReviews(fetched, [], { onlyNew: true, maxReviews: 200 });
    assert.equal(result.firstRun, true);
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['a', 'b', 'c']);
    assert.deepEqual(result.nextSeen, ['a', 'b', 'c']);
    assert.equal(result.skippedAsSeen, 0);
});

test('second run emits only ids absent from the stored set', () => {
    const result = selectNewReviews([r('d'), r('c'), r('b')], ['c', 'b', 'a'], {
        onlyNew: true,
        maxReviews: 200,
    });
    assert.equal(result.firstRun, false);
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['d']);
    assert.equal(result.skippedAsSeen, 2);
    // Newest first, previous tail preserved, no duplicates.
    assert.deepEqual(result.nextSeen, ['d', 'c', 'b', 'a']);
});

test('a run where nothing changed emits nothing and leaves state equivalent', () => {
    const result = selectNewReviews([r('b'), r('a')], ['b', 'a'], { onlyNew: true, maxReviews: 200 });
    assert.deepEqual(result.emitted, []);
    assert.equal(result.skippedAsSeen, 2);
    assert.deepEqual(new Set(result.nextSeen), new Set(['a', 'b']));
});

test('onlyNew=false re-emits everything but still advances state', () => {
    const result = selectNewReviews([r('c'), r('b')], ['b', 'a'], { onlyNew: false, maxReviews: 200 });
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['c', 'b']);
    assert.equal(result.firstRun, false);
    assert.equal(result.skippedAsSeen, 0);
    assert.deepEqual(result.nextSeen, ['c', 'b', 'a']);
});

test('maxReviews caps emission but the whole fetch is still marked seen', () => {
    // Regression guard: if the cap truncated emission AND state, the overflow
    // would be re-emitted forever on every subsequent run.
    const fetched = [r('e'), r('d'), r('c'), r('b')];
    const result = selectNewReviews(fetched, ['a'], { onlyNew: true, maxReviews: 2 });
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['e', 'd']);
    assert.deepEqual(result.nextSeen, ['e', 'd', 'c', 'b', 'a']);

    const next = selectNewReviews(fetched, result.nextSeen, { onlyNew: true, maxReviews: 2 });
    assert.deepEqual(next.emitted, []);
});

test('maxReviews of 0 emits nothing but does not crash', () => {
    const result = selectNewReviews([r('a')], [], { onlyNew: true, maxReviews: 0 });
    assert.deepEqual(result.emitted, []);
    assert.deepEqual(result.nextSeen, ['a']);
});

test('duplicate ids inside one fetch are collapsed', () => {
    const result = selectNewReviews([r('a'), r('a'), r('b')], [], { onlyNew: true, maxReviews: 200 });
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['a', 'b']);
    assert.deepEqual(result.nextSeen, ['a', 'b']);
});

test('reviews without an id are dropped rather than persisted as empty keys', () => {
    const result = selectNewReviews([{ reviewId: '' }, r('b')], [], { onlyNew: true, maxReviews: 200 });
    assert.deepEqual(result.emitted.map((x) => x.reviewId), ['b']);
    assert.deepEqual(result.nextSeen, ['b']);
});

test('the seen list is bounded so the state record cannot grow forever', () => {
    const seen = Array.from({ length: MAX_SEEN_IDS }, (_, i) => `old-${i}`);
    const result = selectNewReviews([r('fresh')], seen, { onlyNew: true, maxReviews: 200 });
    assert.equal(result.nextSeen.length, MAX_SEEN_IDS);
    assert.equal(result.nextSeen[0], 'fresh');
    // The oldest id fell off the tail.
    assert.equal(result.nextSeen.includes(`old-${MAX_SEEN_IDS - 1}`), false);
});

test('state survives a full round trip over three simulated scheduled runs', () => {
    let seen: string[] = [];
    const day1 = selectNewReviews([r('r3'), r('r2'), r('r1')], seen, { onlyNew: true, maxReviews: 100 });
    seen = day1.nextSeen;
    assert.equal(day1.emitted.length, 3);

    const day2 = selectNewReviews([r('r4'), r('r3'), r('r2')], seen, { onlyNew: true, maxReviews: 100 });
    seen = day2.nextSeen;
    assert.deepEqual(day2.emitted.map((x) => x.reviewId), ['r4']);

    const day3 = selectNewReviews([r('r4'), r('r3')], seen, { onlyNew: true, maxReviews: 100 });
    assert.deepEqual(day3.emitted, []);
});

test('rating filters are inclusive on both bounds', () => {
    assert.equal(passesRatingFilter(r('x', 3), { minRating: 3, maxRating: 3 }), true);
    assert.equal(passesRatingFilter(r('x', 2), { minRating: 3 }), false);
    assert.equal(passesRatingFilter(r('x', 4), { maxRating: 3 }), false);
    assert.equal(passesRatingFilter(r('x', 4), {}), true);
    assert.equal(passesRatingFilter(r('x', 4), { minRating: null, maxRating: null }), true);
});

test('an unrated review fails an active rating filter but passes when none is set', () => {
    assert.equal(passesRatingFilter(r('x', null), {}), true);
    assert.equal(passesRatingFilter(r('x', null), { maxRating: 2 }), false);
});

test('applyRatingFilter keeps only the matching window', () => {
    const rows = [r('a', 1), r('b', 3), r('c', 5), r('d', null)];
    assert.deepEqual(applyRatingFilter(rows, { maxRating: 3 }).map((x) => x.reviewId), ['a', 'b']);
    assert.deepEqual(applyRatingFilter(rows, {}).map((x) => x.reviewId), ['a', 'b', 'c', 'd']);
});

test('averageRating ignores unrated rows and returns null when there are none', () => {
    assert.equal(averageRating([r('a', 5), r('b', 4), r('c', null)]), 4.5);
    assert.equal(averageRating([r('a', 1), r('b', 2), r('c', 2)]), 1.67);
    assert.equal(averageRating([]), null);
    assert.equal(averageRating([r('a', null)]), null);
});

test('lowestRated returns the worst reviews first, excluding unrated ones', () => {
    const rows = [r('a', 5), r('b', 1), r('c', 3), r('d', null), r('e', 2)];
    assert.deepEqual(lowestRated(rows, 3).map((x) => x.reviewId), ['b', 'e', 'c']);
    assert.deepEqual(lowestRated([], 3), []);
});

test('lowestRated does not mutate the caller array', () => {
    const rows = [r('a', 5), r('b', 1)];
    lowestRated(rows, 2);
    assert.deepEqual(rows.map((x) => x.reviewId), ['a', 'b']);
});
