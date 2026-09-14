import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseNextLink, RateLimiter, retryDelayMs, isRetryableStatus, parseRateLimitHeaders } from '../src/http.js';
import { MastodonClient, MASTODON_PAGE_LIMIT, sameOrigin } from '../src/mastodon.js';
import { BlueskyClient, BLUESKY_PAGE_LIMIT, AUTHOR_FEED_FILTERS } from '../src/bluesky.js';

const NEVER_STOP = () => false;
const noopLog = { info() {}, warning() {}, error() {}, exception() {} };

/** Collect an async iterator into an array. */
async function drain(iterator) {
    const out = [];
    for await (const item of iterator) out.push(item);
    return out;
}

describe('parseNextLink (Mastodon Link-header pagination)', () => {
    test('extracts rel="next" from a real header', () => {
        const header = '<https://mastodon.social/api/v1/accounts/1/statuses?limit=3&max_id=117264793025914282>; rel="next", '
            + '<https://mastodon.social/api/v1/accounts/1/statuses?limit=3&min_id=117265110451542347>; rel="prev"';
        assert.equal(
            parseNextLink(header),
            'https://mastodon.social/api/v1/accounts/1/statuses?limit=3&max_id=117264793025914282',
        );
    });

    test('returns null when only rel="prev" is offered -- the end of the collection', () => {
        assert.equal(parseNextLink('<https://example.com/a?min_id=1>; rel="prev"'), null);
    });

    test('handles an absent, empty or malformed header', () => {
        assert.equal(parseNextLink(undefined), null);
        assert.equal(parseNextLink(null), null);
        assert.equal(parseNextLink(''), null);
        assert.equal(parseNextLink('garbage'), null);
    });

    test('is not confused by a comma inside the URL itself', () => {
        const header = '<https://example.com/a?q=x,y&max_id=5>; rel="next"';
        assert.equal(parseNextLink(header), 'https://example.com/a?q=x,y&max_id=5');
    });

    test('accepts unquoted rel and extra parameters', () => {
        assert.equal(parseNextLink('<https://example.com/n>; rel=next; type="x"'), 'https://example.com/n');
    });
});

describe('MastodonClient pagination', () => {
    /** Serve canned pages, recording the URLs requested. */
    function stubClient(pages) {
        const requested = [];
        let call = 0;
        const requestJson = async (url) => {
            requested.push(url);
            const page = pages[call] ?? { body: [], link: null };
            call += 1;
            return { body: page.body, headers: new Headers(page.link ? { link: page.link } : {}), url };
        };
        const client = new MastodonClient({
            limiter: new RateLimiter({ defaultIntervalMs: 0 }), userAgent: 'test', log: noopLog, requestJson,
        });
        return { client, requested };
    }

    const status = (id) => ({ id: String(id), created_at: '2026-09-01T00:00:00.000Z' });

    test('follows Link headers across pages until none is offered', async () => {
        const { client, requested } = stubClient([
            { body: [status(1), status(2)], link: '<https://mastodon.social/page2>; rel="next"' },
            { body: [status(3)], link: null },
        ]);
        const items = await drain(client.accountStatuses('mastodon.social', '1', {
            includeReplies: false, includeReposts: false, pageSize: 2, shouldStop: NEVER_STOP,
        }));
        assert.deepEqual(items.map((s) => s.id), ['1', '2', '3']);
        assert.equal(requested[1], 'https://mastodon.social/page2', 'second request used the Link URL verbatim');
    });

    test('stops on an empty page even when a Link header is still offered', async () => {
        const { client } = stubClient([
            { body: [], link: '<https://mastodon.social/page2>; rel="next"' },
        ]);
        assert.deepEqual(await drain(client.tagTimeline('mastodon.social', 'x', {
            pageSize: 10, shouldStop: NEVER_STOP,
        })), []);
    });

    test('shouldStop halts mid-page and no further request is made', async () => {
        const { client, requested } = stubClient([
            { body: [status(1), status(2), status(3)], link: '<https://mastodon.social/page2>; rel="next"' },
            { body: [status(4)], link: null },
        ]);
        const items = await drain(client.accountStatuses('mastodon.social', '1', {
            includeReplies: false,
            includeReposts: false,
            pageSize: 3,
            shouldStop: (s) => s.id === '3',
        }));
        assert.deepEqual(items.map((s) => s.id), ['1', '2']);
        assert.equal(requested.length, 1, 'stopped before fetching page 2');
    });

    test('excludes replies and boosts server-side when they are not wanted', async () => {
        const { client, requested } = stubClient([{ body: [status(1)], link: null }]);
        await drain(client.accountStatuses('mastodon.social', '1', {
            includeReplies: false, includeReposts: false, pageSize: 10, shouldStop: NEVER_STOP,
        }));
        const url = new URL(requested[0]);
        assert.equal(url.searchParams.get('exclude_replies'), 'true');
        assert.equal(url.searchParams.get('exclude_reblogs'), 'true');
    });

    test('omits the exclude params when replies and boosts are wanted', async () => {
        const { client, requested } = stubClient([{ body: [status(1)], link: null }]);
        await drain(client.accountStatuses('mastodon.social', '1', {
            includeReplies: true, includeReposts: true, pageSize: 10, shouldStop: NEVER_STOP,
        }));
        const url = new URL(requested[0]);
        assert.equal(url.searchParams.get('exclude_replies'), null);
        assert.equal(url.searchParams.get('exclude_reblogs'), null);
    });

    test('refuses to follow a pagination link to another origin', async () => {
        // The Link header comes from the remote server. Following it blindly would let any
        // instance -- or one that has been compromised -- redirect our requests at cloud
        // metadata or an internal service.
        const { client, requested } = stubClient([
            { body: [status(1)], link: '<http://169.254.169.254/latest/meta-data/>; rel="next"' },
            { body: [status(2)], link: null },
        ]);
        const items = await drain(client.tagTimeline('mastodon.social', 'x', {
            pageSize: 10, shouldStop: NEVER_STOP,
        }));
        assert.deepEqual(items.map((s) => s.id), ['1'], 'stopped at the hostile link');
        assert.equal(requested.length, 1);
        assert.equal(requested.some((url) => url.includes('169.254')), false);
    });

    test('follows a same-origin pagination link normally', async () => {
        const { client, requested } = stubClient([
            { body: [status(1)], link: '<https://mastodon.social/api/v1/timelines/tag/x?max_id=5>; rel="next"' },
            { body: [status(2)], link: null },
        ]);
        const items = await drain(client.tagTimeline('mastodon.social', 'x', {
            pageSize: 10, shouldStop: NEVER_STOP,
        }));
        assert.deepEqual(items.map((s) => s.id), ['1', '2']);
        assert.equal(requested.length, 2);
    });

    test('sameOrigin rejects a different host, scheme or port, and malformed URLs', () => {
        assert.equal(sameOrigin('https://mastodon.social/a', 'https://mastodon.social'), true);
        assert.equal(sameOrigin('https://evil.com/a', 'https://mastodon.social'), false);
        assert.equal(sameOrigin('http://mastodon.social/a', 'https://mastodon.social'), false);
        assert.equal(sameOrigin('https://mastodon.social:8443/a', 'https://mastodon.social'), false);
        assert.equal(sameOrigin('not a url', 'https://mastodon.social'), false);
    });

    test('never asks for more than the 40 items Mastodon actually returns', async () => {
        const { client, requested } = stubClient([{ body: [status(1)], link: null }]);
        await drain(client.accountStatuses('mastodon.social', '1', {
            includeReplies: false, includeReposts: false, pageSize: 500, shouldStop: NEVER_STOP,
        }));
        assert.equal(
            new URL(requested[0]).searchParams.get('limit'),
            String(MASTODON_PAGE_LIMIT),
            'a larger limit is silently capped by the server, so asking for it hides the truth',
        );
    });
});

describe('BlueskyClient cursor pagination', () => {
    function stubClient(pages) {
        const requested = [];
        let call = 0;
        const requestJson = async (url) => {
            requested.push(url);
            const page = pages[call] ?? { feed: [] };
            call += 1;
            return { body: page, headers: new Headers(), url };
        };
        const client = new BlueskyClient({
            limiter: new RateLimiter({ defaultIntervalMs: 0 }), userAgent: 'test', log: noopLog, requestJson,
        });
        return { client, requested };
    }

    const item = (id) => ({ post: { uri: `at://x/app.bsky.feed.post/${id}`, indexedAt: '2026-09-01T00:00:00.000Z' } });

    test('passes the cursor from each page into the next request', async () => {
        const { client, requested } = stubClient([
            { feed: [item('a')], cursor: 'CURSOR_1' },
            { feed: [item('b')], cursor: 'CURSOR_2' },
            { feed: [] },
        ]);
        const items = await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies', pageSize: 1, shouldStop: NEVER_STOP,
        }));
        assert.equal(items.length, 2);
        assert.equal(new URL(requested[0]).searchParams.get('cursor'), null, 'first page sends no cursor');
        assert.equal(new URL(requested[1]).searchParams.get('cursor'), 'CURSOR_1');
        assert.equal(new URL(requested[2]).searchParams.get('cursor'), 'CURSOR_2');
    });

    test('stops when the server omits a cursor', async () => {
        const { client, requested } = stubClient([{ feed: [item('a')] }]);
        assert.equal((await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies', pageSize: 1, shouldStop: NEVER_STOP,
        }))).length, 1);
        assert.equal(requested.length, 1);
    });

    test('a repeated cursor terminates instead of looping forever', async () => {
        // A server that keeps handing back the same cursor would otherwise spin until
        // the run is killed, billing the user for duplicate pages the whole time.
        const { client, requested } = stubClient(Array.from({ length: 50 }, () => ({
            feed: [item('a')], cursor: 'SAME',
        })));
        const items = await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies', pageSize: 1, shouldStop: NEVER_STOP,
        }));
        assert.equal(items.length, 2, 'one page, then the repeat is detected');
        assert.equal(requested.length, 2);
    });

    test('stops on an empty feed', async () => {
        const { client } = stubClient([{ feed: [], cursor: 'MORE' }]);
        assert.deepEqual(await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies', pageSize: 1, shouldStop: NEVER_STOP,
        })), []);
    });

    test('shouldStop halts mid-page without fetching the next', async () => {
        const { client, requested } = stubClient([
            { feed: [item('a'), item('b')], cursor: 'C1' },
            { feed: [item('c')] },
        ]);
        const items = await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies',
            pageSize: 2,
            shouldStop: (i) => i.post.uri.endsWith('b'),
        }));
        assert.equal(items.length, 1);
        assert.equal(requested.length, 1);
    });

    test('an unknown filter falls back to a valid one instead of being silently ignored', async () => {
        // The API accepts any string and quietly applies its default, so a typo would
        // otherwise change the result set with no signal at all.
        const { client, requested } = stubClient([{ feed: [] }]);
        await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replied', pageSize: 1, shouldStop: NEVER_STOP,
        }));
        const sent = new URL(requested[0]).searchParams.get('filter');
        assert.ok(AUTHOR_FEED_FILTERS.has(sent), `fell back to an invalid filter: ${sent}`);
    });

    test('every filter the scraper asks for is one the API documents', () => {
        // The two values scrape.js chooses between must stay inside the accepted set.
        for (const filter of ['posts_with_replies', 'posts_no_replies']) {
            assert.ok(AUTHOR_FEED_FILTERS.has(filter), `${filter} is not an accepted filter`);
        }
    });

    test('caps the page size at the API maximum', async () => {
        const { client, requested } = stubClient([{ feed: [] }]);
        await drain(client.authorFeed('bsky.app', {
            filter: 'posts_no_replies', pageSize: 9999, shouldStop: NEVER_STOP,
        }));
        assert.equal(
            new URL(requested[0]).searchParams.get('limit'),
            String(BLUESKY_PAGE_LIMIT),
            'asking for more than the API returns hides the real page size',
        );
    });
});

describe('rate limiting and retries', () => {
    test('requests to one host are serialised and spaced', async () => {
        const limiter = new RateLimiter({ defaultIntervalMs: 30 });
        const order = [];
        await Promise.all([1, 2, 3].map((n) => limiter.schedule('h', async () => {
            order.push(`start${n}`);
            order.push(`end${n}`);
        })));
        assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
    });

    test('different hosts do not block each other', async () => {
        const limiter = new RateLimiter({ defaultIntervalMs: 50 });
        const started = new Date();
        await Promise.all([
            limiter.schedule('a', async () => {}),
            limiter.schedule('b', async () => {}),
        ]);
        assert.ok(Date.now() - started < 100, 'ran concurrently rather than back to back');
    });

    test('a low remaining budget stretches the interval', () => {
        const limiter = new RateLimiter({ defaultIntervalMs: 10 });
        limiter.configure('h', 10);
        limiter.observeBudget('h', { remaining: 2, resetAt: Date.now() + 10_000 });
        assert.ok(limiter.hosts.get('h').interval > 1_000, 'slowed down to cover the window');
    });

    test('a healthy budget leaves the interval alone', () => {
        const limiter = new RateLimiter({ defaultIntervalMs: 10 });
        limiter.configure('h', 10);
        limiter.observeBudget('h', { remaining: 290, resetAt: Date.now() + 10_000 });
        assert.equal(limiter.hosts.get('h').interval, 10);
    });

    test('parses Mastodon\'s ISO reset header and epoch-second headers alike', () => {
        const iso = parseRateLimitHeaders(new Headers({
            'x-ratelimit-remaining': '297', 'x-ratelimit-reset': '2026-09-14T05:25:00.005892Z',
        }));
        assert.equal(iso.remaining, 297);
        assert.equal(iso.resetAt, Date.parse('2026-09-14T05:25:00.005892Z'));

        const epoch = parseRateLimitHeaders(new Headers({ 'x-ratelimit-reset': '1789000000' }));
        assert.equal(epoch.resetAt, 1789000000 * 1000);
    });

    test('missing rate-limit headers yield nulls rather than NaN', () => {
        assert.deepEqual(parseRateLimitHeaders(new Headers()), { remaining: null, resetAt: null });
    });

    test('only transient statuses are retried', () => {
        for (const status of [429, 408, 500, 502, 503]) {
            assert.equal(isRetryableStatus(status), true, `${status} should retry`);
        }
        for (const status of [400, 401, 403, 404, 422]) {
            assert.equal(isRetryableStatus(status), false, `${status} should not retry`);
        }
    });

    test('Retry-After in seconds is honoured', () => {
        assert.equal(retryDelayMs(1, '5'), 5_000);
    });

    test('Retry-After as an HTTP date is honoured', () => {
        const delay = retryDelayMs(1, new Date(Date.now() + 4_000).toUTCString());
        assert.ok(delay > 2_000 && delay <= 5_000, `unexpected delay ${delay}`);
    });

    test('backoff grows with the attempt number and stays bounded', () => {
        const first = retryDelayMs(1);
        const third = retryDelayMs(3);
        assert.ok(third > first);
        assert.ok(retryDelayMs(10) <= 30_000, 'capped so a run cannot stall indefinitely');
    });
});
