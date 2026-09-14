import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunNote, isTransientSourceFailure } from '../src/outcome.ts';
import { AppleAppNotFoundError, AppleFeedUnavailableError } from '../src/sources/apple.ts';
import { GooglePlayFeedUnavailableError } from '../src/sources/google-play.ts';
import { buildWebhookPayload } from '../src/webhook.ts';
import type { AppCheckResult } from '../src/types.ts';

const result = (over: Partial<AppCheckResult> = {}): AppCheckResult => ({
    store: 'app-store',
    appId: '284882215',
    appName: 'Facebook',
    country: 'us',
    fetchedCount: 0,
    newCount: 0,
    avgRating: null,
    lowestReviews: [],
    firstRun: false,
    ...over,
});

test('a store refusing to serve data is classified transient', () => {
    assert.equal(isTransientSourceFailure(new AppleFeedUnavailableError('1', 'us', 500)), true);
    assert.equal(isTransientSourceFailure(new GooglePlayFeedUnavailableError('a.b', 'us', 500)), true);
});

test('network and server faults are transient', () => {
    for (const message of [
        'HTTP 429 Too Many Requests from https://...',
        'HTTP 503 Service Unavailable from https://...',
        'fetch failed',
        'ETIMEDOUT',
        'ENOTFOUND itunes.apple.com',
        'The operation was aborted due to timeout',
    ]) {
        assert.equal(isTransientSourceFailure(new Error(message)), true, message);
    }
});

test("a user's bad input is NOT transient, so it still fails a run that finds nothing else", () => {
    assert.equal(isTransientSourceFailure(new AppleAppNotFoundError('999', 'us')), false);
    assert.equal(isTransientSourceFailure(new Error('HTTP 404 Not Found from https://...')), false);
    assert.equal(isTransientSourceFailure(new Error('App not found (404)')), false);
    assert.equal(isTransientSourceFailure(new Error('`countries` must contain at least one ISO-3166')), false);
});

test('a 4xx that is not 429 is never treated as retriable', () => {
    // Retrying a 400/403/404 forever burns time and the user's 5-minute window
    // without any chance of a different answer.
    for (const code of [400, 401, 403, 404, 410]) {
        assert.equal(isTransientSourceFailure(new Error(`HTTP ${code} whatever from https://x`)), false, String(code));
    }
});

test('a clean run note states what happened without mentioning failures', () => {
    const note = buildRunNote(4, 12, [], []);
    assert.match(note, /Checked 4 app\/country pair\(s\); emitted 12 new review\(s\)\./);
    assert.doesNotMatch(note, /skipped|failed/i);
});

test('a quiet run says explicitly that every app WAS reached', () => {
    // The whole hazard this actor guards against: "no new reviews" must never be
    // ambiguous with "we could not look".
    const note = buildRunNote(4, 0, [], []);
    assert.match(note, /No new reviews since the last run — every app was reached successfully\./);
});

test('a run note names skipped apps and promises recovery', () => {
    const note = buildRunNote(4, 3, [result({ error: 'feed down', transient: true })], []);
    assert.match(note, /1 app\(s\) were skipped/);
    assert.match(note, /nothing was marked as seen/i);
    assert.match(note, /next run re-fetches them in full/);
    assert.doesNotMatch(note, /No new reviews since the last run/);
});

test('a run note surfaces a real failure with its message', () => {
    const note = buildRunNote(2, 0, [], [result({ appId: '999', error: 'No app with ID 999 exists', transient: false })]);
    assert.match(note, /failed for a reason worth checking/);
    assert.match(note, /999 \(us\) — No app with ID 999 exists/);
});

test('skipped apps and failed apps are counted separately in the webhook payload', () => {
    const payload = buildWebhookPayload(
        [
            result({ newCount: 5, avgRating: 4 }),
            result({ appId: 'x', error: 'feed down', transient: true }),
            result({ appId: 'y', error: 'no such app', transient: false }),
        ],
        'a note',
    );
    assert.equal(payload.totals.appsChecked, 3);
    assert.equal(payload.totals.newReviews, 5);
    assert.equal(payload.totals.skipped, 1);
    assert.equal(payload.totals.errors, 1);
    assert.equal(payload.runNote, 'a note');
    assert.equal(payload.apps[1]!.skipped, true);
    assert.equal(payload.apps[2]!.skipped, undefined);
    assert.equal(payload.apps[0]!.error, undefined);
});

test('webhook review text is truncated so a huge review cannot blow up a Slack payload', () => {
    const long = 'x'.repeat(2000);
    const payload = buildWebhookPayload([
        result({
            newCount: 1,
            lowestReviews: [
                {
                    store: 'app-store',
                    appId: '1',
                    appName: null,
                    country: 'us',
                    reviewId: 'r1',
                    rating: 1,
                    title: null,
                    text: long,
                    author: null,
                    date: null,
                    appVersion: null,
                    developerReply: null,
                    url: 'https://example.com',
                    isNew: true,
                },
            ],
        }),
    ]);
    const text = payload.apps[0]!.lowestReviews[0]!.text;
    assert.ok(text.length < long.length);
    assert.ok(text.endsWith('…'));
});
