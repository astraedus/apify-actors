import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APPLE_MAX_PAGES, APPLE_PAGE_SIZE, appleFeedUrl, parseAppleRssPage } from '../src/sources/apple.ts';

/** Fixtures captured live from the Facebook (284882215) US feed on 2026-09-14. */
const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));

const CONTEXT = { appId: '284882215', appName: 'Facebook', country: 'us' };

test('parses a real RSS page into normalised rows', () => {
    const rows = parseAppleRssPage(fixture('apple-rss-page1'), CONTEXT);
    assert.equal(rows.length, 4);

    const first = rows[0]!;
    assert.deepEqual(first, {
        store: 'app-store',
        appId: '284882215',
        appName: 'Facebook',
        country: 'us',
        reviewId: '14543621019',
        rating: 5,
        title: 'Stalking Frank',
        text: 'He’s so sexy daddy my fave puppet',
        author: 'Maki loves Franklin',
        date: '2026-09-13T04:23:20.000Z',
        appVersion: '578.1',
        developerReply: null,
        url: 'https://apps.apple.com/us/app/id284882215',
        isNew: true,
    });
});

test('review ids from the fixture are unique and stable', () => {
    const rows = parseAppleRssPage(fixture('apple-rss-page1'), CONTEXT);
    const ids = rows.map((r) => r.reviewId);
    assert.deepEqual(ids, ['14543621019', '14543568485', '14543563780', '14543500206']);
    assert.equal(new Set(ids).size, ids.length);
});

test('dates are converted from Apple local offsets to ISO-8601 UTC', () => {
    const rows = parseAppleRssPage(fixture('apple-rss-page1'), CONTEXT);
    for (const row of rows) {
        assert.match(row.date!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
});

test('a page past the last one returns no rows instead of throwing', () => {
    // Apple answers HTTP 200 with the feed envelope and no `entry` key — this is
    // the pagination termination signal, verified live against page=11.
    assert.deepEqual(parseAppleRssPage(fixture('apple-rss-empty'), CONTEXT), []);
});

test('a single review arriving as a bare object is handled like a one-element list', () => {
    const rows = parseAppleRssPage(fixture('apple-rss-single-entry'), CONTEXT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reviewId, '14543621019');
});

test('entries without a rating are dropped (some feeds prepend the app itself)', () => {
    const payload = {
        feed: {
            entry: [
                { id: { label: 'app-entry' }, 'im:name': { label: 'Facebook' }, title: { label: 'Facebook' } },
                { id: { label: 'r1' }, 'im:rating': { label: '3' }, content: { label: 'meh' } },
            ],
        },
    };
    const rows = parseAppleRssPage(payload, CONTEXT);
    assert.deepEqual(rows.map((r) => r.reviewId), ['r1']);
});

test('malformed and empty payloads degrade to an empty list, never a crash', () => {
    for (const payload of [null, undefined, {}, { feed: null }, { feed: { entry: null } }, 'nonsense', 42]) {
        assert.deepEqual(parseAppleRssPage(payload, CONTEXT), [], JSON.stringify(payload));
    }
});

test('missing optional fields become null rather than the string "undefined"', () => {
    const rows = parseAppleRssPage(
        { feed: { entry: [{ id: { label: 'r1' }, 'im:rating': { label: '4' } }] } },
        CONTEXT,
    );
    const row = rows[0]!;
    assert.equal(row.title, null);
    assert.equal(row.author, null);
    assert.equal(row.date, null);
    assert.equal(row.appVersion, null);
    assert.equal(row.text, '');
    assert.equal(row.rating, 4);
});

test('an unparseable date becomes null instead of Invalid Date', () => {
    const rows = parseAppleRssPage(
        { feed: { entry: [{ id: { label: 'r1' }, 'im:rating': { label: '4' }, updated: { label: 'not a date' } }] } },
        CONTEXT,
    );
    assert.equal(rows[0]!.date, null);
});

test('a non-numeric rating becomes null rather than NaN', () => {
    const rows = parseAppleRssPage(
        { feed: { entry: [{ id: { label: 'r1' }, 'im:rating': { label: 'five' } }] } },
        CONTEXT,
    );
    assert.equal(rows[0]!.rating, null);
});

test('the App Store feed never carries developer replies', () => {
    const rows = parseAppleRssPage(fixture('apple-rss-page1'), CONTEXT);
    assert.ok(rows.every((r) => r.developerReply === null));
});

test('feed URLs are built for the documented endpoint and are country-encoded', () => {
    assert.equal(
        appleFeedUrl('284882215', 'gb', 3),
        'https://itunes.apple.com/gb/rss/customerreviews/id=284882215/sortBy=mostRecent/page=3/json',
    );
});

test('the Apple page limits match the documented public feed ceiling', () => {
    assert.equal(APPLE_MAX_PAGES, 10);
    assert.equal(APPLE_PAGE_SIZE, 50);
});
