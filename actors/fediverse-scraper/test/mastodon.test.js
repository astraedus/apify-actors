import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { htmlToText, decodeEntities } from '../src/normalize.js';
import { canonicalHandle, normaliseAccount, normaliseProfileRow, normaliseStatusRow, timelineTime } from '../src/mastodon.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Real mastodon.social API responses, captured 2026-09-14. */
const ACCOUNT = load('mastodon-account.json');
const STATUSES = load('mastodon-statuses.json');
const [PLAIN, WITH_MEDIA, REPLY, BOOST] = STATUSES;

const OPTS = { instance: 'mastodon.social', target: '@Gargron@mastodon.social', includeRaw: false };

describe('htmlToText', () => {
    test('unwraps a paragraph', () => {
        assert.equal(htmlToText('<p>Hello world</p>'), 'Hello world');
    });

    test('<br> becomes a newline, </p> becomes a blank line', () => {
        assert.equal(htmlToText('<p>one<br />two</p><p>three</p>'), 'one\ntwo\n\nthree');
    });

    test('decodes the entities Mastodon emits', () => {
        assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;quotes&quot; don&#39;t break</p>'),
            'Tom & Jerry <3 "quotes" don\'t break');
    });

    test('decodes numeric and hex character references', () => {
        assert.equal(decodeEntities('&#8230;&#x2014;&#65;'), '…—A');
    });

    test('leaves an unknown entity alone rather than mangling it', () => {
        assert.equal(decodeEntities('&notarealentity; &amp;'), '&notarealentity; &');
    });

    test('strips mention and hashtag anchors but keeps their visible text', () => {
        const html = '<p><span class="h-card"><a href="https://mastodon.social/@Mastodon" '
            + 'class="u-url mention">@<span>Mastodon</span></a></span> shipped it</p>';
        assert.equal(htmlToText(html), '@Mastodon shipped it');
    });

    test('collapses runs of blank lines and trims', () => {
        assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
    });

    test('renders list items as bullets', () => {
        assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), '• one\n• two');
    });

    test('empty and nullish input yield an empty string, never "undefined"', () => {
        for (const value of [null, undefined, '', '<p></p>']) {
            assert.equal(htmlToText(value), '');
        }
    });

    test('a real bio from the fixture becomes clean prose with no tags or entities', () => {
        const text = htmlToText(ACCOUNT.note);
        assert.ok(text.includes('Founder of'), 'content survived');
        assert.ok(text.includes('@Mastodon'), 'mention text survived');
        assert.doesNotMatch(text, /<[a-z/]/i, 'no residual tags');
        assert.doesNotMatch(text, /&[a-z]+;|&#\d+;/i, 'no residual entities');
    });

    test('every fixture status converts without leaving markup behind', () => {
        for (const status of STATUSES) {
            const text = htmlToText((status.reblog ?? status).content);
            assert.doesNotMatch(text, /<[a-z/]/i, `tags left in status ${status.id}`);
            assert.doesNotMatch(text, /&(amp|lt|gt|quot|#\d+);/i, `entities left in status ${status.id}`);
        }
    });
});

describe('canonicalHandle', () => {
    test('a local acct gains the instance, a remote acct only gains the @', () => {
        assert.equal(canonicalHandle('Gargron', 'mastodon.social'), '@Gargron@mastodon.social');
        assert.equal(canonicalHandle('user@fosstodon.org', 'mastodon.social'), '@user@fosstodon.org');
    });

    test('a missing acct is null rather than "@undefined"', () => {
        assert.equal(canonicalHandle(undefined, 'mastodon.social'), null);
    });
});

describe('normaliseAccount', () => {
    const author = normaliseAccount(ACCOUNT, 'mastodon.social');

    test('maps the real account fixture onto the shared author shape', () => {
        assert.equal(author.handle, '@Gargron@mastodon.social');
        assert.equal(author.displayName, 'Eugen Rochko');
        assert.equal(author.url, 'https://mastodon.social/@Gargron');
        assert.equal(typeof author.followers, 'number');
        assert.ok(author.followers > 0);
        assert.equal(typeof author.postsCount, 'number');
        assert.equal(author.avatar, ACCOUNT.avatar);
    });

    test('timestamps are normalised to ISO-8601', () => {
        assert.match(author.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('the bio is plain text, not HTML', () => {
        assert.doesNotMatch(author.bio, /<[a-z/]/i);
    });
});

describe('normaliseStatusRow', () => {
    test('a plain post maps onto the canonical row', () => {
        const row = normaliseStatusRow(PLAIN, OPTS);
        assert.equal(row.platform, 'mastodon');
        assert.equal(row.type, 'post');
        assert.equal(row.id, PLAIN.id);
        assert.equal(row.url, PLAIN.url);
        assert.equal(row.isRepost, false);
        assert.equal(row.inReplyTo, null);
        assert.equal(row.text, htmlToText(PLAIN.content));
        assert.equal(row.target, OPTS.target);
        assert.match(row.scrapedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    test('engagement counts come across as numbers', () => {
        const row = normaliseStatusRow(PLAIN, OPTS);
        for (const field of ['replies', 'reposts', 'likes']) {
            assert.equal(typeof row[field], 'number', `${field} should be numeric`);
        }
    });

    test('media carries the URL, type and alt text', () => {
        const row = normaliseStatusRow(WITH_MEDIA, OPTS);
        assert.ok(row.media.length > 0, 'fixture has attachments');
        for (const item of row.media) {
            assert.ok(item.url.startsWith('http'), 'a usable URL');
            assert.ok(typeof item.type === 'string' && item.type.length > 0);
            assert.ok('alt' in item, 'alt is always present, null when the poster omitted it');
        }
    });

    test('resolveMedia: false drops media without disturbing anything else', () => {
        const withMedia = normaliseStatusRow(WITH_MEDIA, OPTS);
        const without = normaliseStatusRow(WITH_MEDIA, { ...OPTS, resolveMedia: false });
        assert.deepEqual(without.media, []);
        assert.equal(without.text, withMedia.text);
        assert.equal(without.id, withMedia.id);
    });

    test('hashtags and mentions are extracted and de-duplicated', () => {
        const row = normaliseStatusRow(WITH_MEDIA, OPTS);
        assert.deepEqual(row.hashtags, [...new Set(row.hashtags)], 'no duplicates');
        assert.deepEqual(row.hashtags, WITH_MEDIA.tags.map((t) => t.name));
        for (const mention of row.mentions) {
            assert.match(mention, /^@/, 'mentions are canonical handles');
        }
    });

    test('a reply records the parent id', () => {
        const row = normaliseStatusRow(REPLY, OPTS);
        assert.equal(row.inReplyTo, REPLY.in_reply_to_id);
        assert.ok(row.inReplyTo, 'fixture really is a reply');
    });

    test('a boost is credited to the original author and keyed on the boost', () => {
        const row = normaliseStatusRow(BOOST, OPTS);
        assert.equal(row.isRepost, true);
        // The wrapper is hollow: taking its content would emit an empty post.
        assert.equal(BOOST.content, '');
        assert.ok(row.text.length > 0, 'text comes from the boosted status');
        assert.equal(row.text, htmlToText(BOOST.reblog.content));
        assert.equal(row.url, BOOST.reblog.url, 'url points at the original post');
        assert.equal(row.author.handle, `@${BOOST.reblog.account.acct}@mastodon.social`);
        assert.equal(row.id, BOOST.id, 'keyed on the boost so two boosts are two rows');
        assert.notEqual(row.id, BOOST.reblog.id);
    });

    test('includeRaw attaches the untouched payload, and omits the key otherwise', () => {
        assert.equal('raw' in normaliseStatusRow(PLAIN, OPTS), false);
        const withRaw = normaliseStatusRow(PLAIN, { ...OPTS, includeRaw: true });
        assert.deepEqual(withRaw.raw, PLAIN);
    });
});

describe('row schema is uniform', () => {
    const EXPECTED_KEYS = [
        'platform', 'type', 'id', 'url', 'author', 'text', 'createdAt', 'language',
        'replies', 'reposts', 'likes', 'media', 'hashtags', 'mentions', 'inReplyTo',
        'isRepost', 'target', 'scrapedAt',
    ];

    test('profile and post rows expose exactly the same keys in the same order', () => {
        const profile = normaliseProfileRow(ACCOUNT, OPTS);
        const post = normaliseStatusRow(PLAIN, OPTS);
        assert.deepEqual(Object.keys(profile), EXPECTED_KEYS);
        assert.deepEqual(Object.keys(post), EXPECTED_KEYS);
    });

    test('a profile row describes the account itself', () => {
        const row = normaliseProfileRow(ACCOUNT, OPTS);
        assert.equal(row.type, 'profile');
        assert.equal(row.id, ACCOUNT.id);
        assert.equal(row.author.handle, '@Gargron@mastodon.social');
        assert.equal(row.text, row.author.bio, 'text mirrors the bio for profile rows');
    });

    test('inapplicable fields are null, never missing', () => {
        const row = normaliseProfileRow(ACCOUNT, OPTS);
        for (const field of ['replies', 'reposts', 'likes', 'language']) {
            assert.equal(row[field], null, `${field} should be an explicit null on a profile row`);
        }
    });
});

describe('timelineTime', () => {
    test('reads the wrapper timestamp, which is the boost time for a boost', () => {
        assert.equal(timelineTime(BOOST), Date.parse(BOOST.created_at));
        assert.ok(
            timelineTime(BOOST) >= Date.parse(BOOST.reblog.created_at),
            'boost time is never earlier than the original, so stopping on it is safe',
        );
    });

    test('unparseable input degrades to 0 instead of NaN', () => {
        // NaN comparisons are always false, which would silently disable the since cut-off.
        assert.equal(timelineTime({ created_at: 'not a date' }), 0);
    });
});
