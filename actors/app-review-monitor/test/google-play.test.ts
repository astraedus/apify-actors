import test from 'node:test';
import assert from 'node:assert/strict';

import gplay from 'google-play-scraper';
import {
    GOOGLE_PLAY_MAX_REVIEWS,
    SORT_NEWEST_FALLBACK,
    newestSortValue,
    normaliseGooglePlayReview,
} from '../src/sources/google-play.ts';

const CONTEXT = { appId: 'dev.astraedus.nudge', appName: 'Nudge', country: 'us' };

/** A verbatim review object from google-play-scraper 10.1.3, captured 2026-09-14. */
const LIVE_SHAPE = {
    id: '6ca5d4fd-5ef6-49bc-877e-159f062a5a91',
    userName: 'sepehr',
    userImage: 'https://play-lh.googleusercontent.com/a/ACg8ocI=mo',
    date: '2026-09-06T09:09:52.941Z',
    score: 3,
    scoreText: '3',
    url: 'https://play.google.com/store/apps/details?id=dev.astraedus.nudge&reviewId=6ca5d4fd-5ef6-49bc-877e-159f062a5a91',
    title: null,
    text: "It doesn't work sometimes",
    replyDate: null,
    replyText: null,
    version: '1.15.2',
    thumbsUp: 0,
    criterias: [{ criteria: 'vaf_app_quality_stability', rating: 2 }],
};

test('normalises a real google-play-scraper review object', () => {
    const row = normaliseGooglePlayReview(LIVE_SHAPE, CONTEXT);
    assert.deepEqual(row, {
        store: 'google-play',
        appId: 'dev.astraedus.nudge',
        appName: 'Nudge',
        country: 'us',
        reviewId: '6ca5d4fd-5ef6-49bc-877e-159f062a5a91',
        rating: 3,
        title: null,
        text: "It doesn't work sometimes",
        author: 'sepehr',
        date: '2026-09-06T09:09:52.941Z',
        appVersion: '1.15.2',
        developerReply: null,
        url: LIVE_SHAPE.url,
        isNew: true,
    });
});

test('a developer reply is carried through with its date', () => {
    const row = normaliseGooglePlayReview(
        { ...LIVE_SHAPE, replyText: 'Sorry about that, fixed in 1.16.', replyDate: '2026-09-07T10:00:00.000Z' },
        CONTEXT,
    );
    assert.deepEqual(row!.developerReply, {
        text: 'Sorry about that, fixed in 1.16.',
        date: '2026-09-07T10:00:00.000Z',
    });
});

test('a reply without a date still produces a reply object', () => {
    const row = normaliseGooglePlayReview({ ...LIVE_SHAPE, replyText: 'Thanks!', replyDate: null }, CONTEXT);
    assert.deepEqual(row!.developerReply, { text: 'Thanks!', date: null });
});

test('an empty reply string is not a reply', () => {
    const row = normaliseGooglePlayReview({ ...LIVE_SHAPE, replyText: '   ' }, CONTEXT);
    assert.equal(row!.developerReply, null);
});

test('a review without an id is rejected rather than emitted with an empty key', () => {
    assert.equal(normaliseGooglePlayReview({ ...LIVE_SHAPE, id: undefined }, CONTEXT), null);
    assert.equal(normaliseGooglePlayReview({}, CONTEXT), null);
});

test('a Date instance for the review date is accepted', () => {
    const row = normaliseGooglePlayReview({ ...LIVE_SHAPE, date: new Date('2026-01-02T03:04:05Z') }, CONTEXT);
    assert.equal(row!.date, '2026-01-02T03:04:05.000Z');
});

test('missing text becomes an empty string, missing score becomes null', () => {
    const row = normaliseGooglePlayReview({ id: 'r1' }, CONTEXT);
    assert.equal(row!.text, '');
    assert.equal(row!.rating, null);
    assert.equal(row!.author, null);
    assert.equal(row!.appVersion, null);
});

test('a review with no url falls back to the app store page', () => {
    const row = normaliseGooglePlayReview({ id: 'r1' }, CONTEXT);
    assert.equal(
        row!.url,
        'https://play.google.com/store/apps/details?id=dev.astraedus.nudge&hl=en&gl=US',
    );
});

test('GUARD: the installed package still numbers sort.NEWEST the way we expect', () => {
    // google-play-scraper 10.1.3 mistypes `sort` as the enum TYPE, so the code
    // reads the value through a cast. If a future release renumbers or renames
    // NEWEST, this fails here instead of silently re-sorting every feed by
    // relevance — which would break "newest reviews since the last run".
    const table = (gplay as unknown as { sort?: Record<string, unknown> }).sort;
    assert.ok(table, 'google-play-scraper no longer exposes a `sort` table');
    assert.equal(table['NEWEST'], SORT_NEWEST_FALLBACK);
    assert.equal(newestSortValue(), SORT_NEWEST_FALLBACK);
});

test('the per-run review ceiling is a sane positive integer', () => {
    assert.ok(Number.isInteger(GOOGLE_PLAY_MAX_REVIEWS) && GOOGLE_PLAY_MAX_REVIEWS > 0);
});
