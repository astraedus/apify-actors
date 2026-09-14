import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    extractFacets,
    extractMedia,
    facetSlice,
    isReply,
    isRepostItem,
    normalisePostRow,
    normaliseProfileRow,
    postUrlFromUri,
    timelineTime,
} from '../src/bluesky.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Real public.api.bsky.app responses, captured 2026-09-14. */
const PROFILE = load('bluesky-profile.json');
const FEED = load('bluesky-feed.json').feed;

const OPTS = { target: 'bsky.app', includeRaw: false };

const findItem = (predicate, label) => {
    const item = FEED.find(predicate);
    assert.ok(item, `fixture must contain ${label}`);
    return item;
};

describe('facetSlice', () => {
    test('slices by UTF-8 byte offsets, not string indices', () => {
        // The emoji is 4 bytes but 2 JS chars: naive string slicing lands 2 chars early.
        const text = '\u{1F600} @alice.bsky.social hi';
        // The emoji occupies bytes 0-3, the space byte 4, the handle bytes 5-22.
        const index = { byteStart: 5, byteEnd: 23 };
        assert.equal(facetSlice(text, index), '@alice.bsky.social');
        assert.notEqual(text.slice(index.byteStart, index.byteEnd), '@alice.bsky.social');
    });

    test('ASCII-only text behaves like a plain slice', () => {
        assert.equal(facetSlice('hello @bob world', { byteStart: 6, byteEnd: 10 }), '@bob');
    });

    test('a malformed or missing index yields an empty string, never a throw', () => {
        assert.equal(facetSlice('text', null), '');
        assert.equal(facetSlice('text', { byteStart: 'x', byteEnd: 2 }), '');
        assert.equal(facetSlice(undefined, { byteStart: 0, byteEnd: 2 }), '');
    });
});

describe('postUrlFromUri', () => {
    test('builds a bsky.app permalink from an at:// URI', () => {
        assert.equal(
            postUrlFromUri('at://did:plc:abc/app.bsky.feed.post/3l6o', 'bsky.app'),
            'https://bsky.app/profile/bsky.app/post/3l6o',
        );
    });

    test('falls back to the DID when no handle is known', () => {
        assert.equal(
            postUrlFromUri('at://did:plc:abc/app.bsky.feed.post/3l6o'),
            'https://bsky.app/profile/did:plc:abc/post/3l6o',
        );
    });

    test('returns null for anything that is not a post URI', () => {
        assert.equal(postUrlFromUri('at://did:plc:abc/app.bsky.graph.follow/x', 'h'), null);
        assert.equal(postUrlFromUri('https://bsky.app/profile/x'), null);
        assert.equal(postUrlFromUri(null), null);
    });
});

describe('extractMedia', () => {
    test('image embeds yield fullsize URLs and alt text', () => {
        const item = findItem((i) => i.post.embed?.$type === 'app.bsky.embed.images#view', 'an image embed');
        const media = extractMedia(item.post.embed);
        assert.ok(media.length > 0);
        for (const entry of media) {
            assert.equal(entry.type, 'image');
            assert.ok(entry.url.startsWith('https://'));
        }
        assert.equal(media[0].url, item.post.embed.images[0].fullsize);
        assert.equal(media[0].alt, item.post.embed.images[0].alt);
    });

    test('video embeds yield the HLS playlist', () => {
        const item = findItem((i) => i.post.embed?.$type === 'app.bsky.embed.video#view', 'a video embed');
        const media = extractMedia(item.post.embed);
        assert.equal(media.length, 1);
        assert.equal(media[0].type, 'video');
        assert.equal(media[0].url, item.post.embed.playlist);
    });

    test('an external link card surfaces the linked URL', () => {
        const media = extractMedia({
            $type: 'app.bsky.embed.external#view',
            external: { uri: 'https://example.com/a', title: 'A title' },
        });
        assert.deepEqual(media, [{ url: 'https://example.com/a', type: 'external', alt: 'A title' }]);
    });

    test('recordWithMedia unwraps to the media half, not the quoted post', () => {
        const images = {
            $type: 'app.bsky.embed.images#view',
            images: [{ fullsize: 'https://cdn/x.jpg', alt: 'x' }],
        };
        const media = extractMedia({ $type: 'app.bsky.embed.recordWithMedia#view', media: images });
        assert.deepEqual(media, [{ url: 'https://cdn/x.jpg', type: 'image', alt: 'x' }]);
    });

    test('a bare quote post carries no media', () => {
        const item = findItem((i) => i.post.embed?.$type === 'app.bsky.embed.record#view', 'a quote embed');
        assert.deepEqual(extractMedia(item.post.embed), []);
    });

    test('missing or unknown embeds yield an empty array', () => {
        assert.deepEqual(extractMedia(undefined), []);
        assert.deepEqual(extractMedia({ $type: 'app.bsky.embed.somethingNew#view' }), []);
    });
});

describe('extractFacets', () => {
    test('reads the mention handle out of the post text rather than emitting a raw DID', () => {
        const item = findItem((i) => i.post.record.facets?.some(
            (f) => f.features?.some((x) => x.$type === 'app.bsky.richtext.facet#mention'),
        ), 'a mention facet');
        const { mentions } = extractFacets(item.post.record);
        assert.ok(mentions.length > 0);
        for (const mention of mentions) {
            assert.match(mention, /^@/, `expected a handle, got ${mention}`);
            assert.doesNotMatch(mention, /^did:/, 'a bare DID is not human-readable');
        }
    });

    test('tag facets and the legacy tags array are merged and de-duplicated', () => {
        const record = {
            text: '#a and #b',
            tags: ['a'],
            facets: [
                { features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'a' }], index: { byteStart: 0, byteEnd: 2 } },
                { features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'b' }], index: { byteStart: 7, byteEnd: 9 } },
            ],
        };
        assert.deepEqual(extractFacets(record).hashtags, ['a', 'b']);
    });

    test('link facets are not mistaken for hashtags or mentions', () => {
        const record = {
            text: 'see example.com',
            facets: [{
                features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
                index: { byteStart: 4, byteEnd: 15 },
            }],
        };
        assert.deepEqual(extractFacets(record), { hashtags: [], mentions: [] });
    });

    test('a record with no facets yields empty arrays, not undefined', () => {
        assert.deepEqual(extractFacets({}), { hashtags: [], mentions: [] });
        assert.deepEqual(extractFacets(undefined), { hashtags: [], mentions: [] });
    });
});

describe('normalisePostRow', () => {
    test('maps a real feed item onto the canonical row', () => {
        const item = findItem((i) => !i.reason && !i.reply, 'a plain post');
        const row = normalisePostRow(item, OPTS);
        assert.equal(row.platform, 'bluesky');
        assert.equal(row.type, 'post');
        assert.equal(row.id, item.post.uri);
        assert.equal(row.text, item.post.record.text);
        assert.equal(row.isRepost, false);
        assert.equal(row.author.handle, `@${item.post.author.handle}`);
        assert.match(row.url, /^https:\/\/bsky\.app\/profile\/.+\/post\/.+$/);
        assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('engagement counts come across as numbers', () => {
        const item = findItem((i) => !i.reason, 'any post');
        const row = normalisePostRow(item, OPTS);
        for (const field of ['replies', 'reposts', 'likes']) {
            assert.equal(typeof row[field], 'number', `${field} should be numeric`);
        }
    });

    test('a repost is credited to the original author but keyed on the repost record', () => {
        const item = findItem(isRepostItem, 'a repost');
        const row = normalisePostRow(item, OPTS);
        assert.equal(row.isRepost, true);
        assert.equal(row.id, item.reason.uri, 'keyed on the repost so two reposts are two rows');
        assert.notEqual(row.id, item.post.uri);
        assert.equal(row.author.handle, `@${item.post.author.handle}`, 'original author, not the reposter');
        assert.equal(row.text, item.post.record.text);
    });

    test('a reply records the parent URI', () => {
        const item = findItem(isReply, 'a reply');
        const row = normalisePostRow(item, OPTS);
        assert.ok(row.inReplyTo, 'a reply must expose its parent');
        assert.match(row.inReplyTo, /^at:\/\//);
    });

    test('language is taken from the first langs entry', () => {
        const item = findItem((i) => i.post.record.langs?.length, 'a post with langs');
        assert.equal(normalisePostRow(item, OPTS).language, item.post.record.langs[0]);
    });

    test('resolveMedia: false drops media without disturbing anything else', () => {
        const item = findItem((i) => i.post.embed?.$type === 'app.bsky.embed.images#view', 'an image embed');
        const on = normalisePostRow(item, OPTS);
        const off = normalisePostRow(item, { ...OPTS, resolveMedia: false });
        assert.ok(on.media.length > 0);
        assert.deepEqual(off.media, []);
        assert.equal(off.text, on.text);
    });

    test('a bare PostView (from getPosts) normalises the same as a feed item', () => {
        const item = findItem((i) => !i.reason, 'any post');
        const fromFeed = normalisePostRow(item, OPTS);
        const fromGetPosts = normalisePostRow(item.post, OPTS);
        assert.equal(fromGetPosts.id, fromFeed.id);
        assert.equal(fromGetPosts.text, fromFeed.text);
        assert.equal(fromGetPosts.isRepost, false);
    });

    test('includeRaw attaches the untouched payload, and omits the key otherwise', () => {
        const item = findItem(() => true, 'any item');
        assert.equal('raw' in normalisePostRow(item, OPTS), false);
        assert.deepEqual(normalisePostRow(item, { ...OPTS, includeRaw: true }).raw, item);
    });

    test('every fixture item normalises without producing undefined in a required field', () => {
        for (const item of FEED) {
            const row = normalisePostRow(item, OPTS);
            for (const [key, value] of Object.entries(row)) {
                assert.notEqual(value, undefined, `${key} is undefined for ${item.post.uri}`);
            }
            assert.equal(typeof row.text, 'string');
            assert.ok(Array.isArray(row.media) && Array.isArray(row.hashtags) && Array.isArray(row.mentions));
        }
    });
});

describe('normaliseProfileRow', () => {
    const row = normaliseProfileRow(PROFILE, OPTS);

    test('maps the real profile fixture', () => {
        assert.equal(row.platform, 'bluesky');
        assert.equal(row.type, 'profile');
        assert.equal(row.id, PROFILE.did);
        assert.equal(row.author.handle, '@bsky.app');
        assert.equal(row.author.followers, PROFILE.followersCount);
        assert.equal(row.author.postsCount, PROFILE.postsCount);
        assert.equal(row.url, 'https://bsky.app/profile/bsky.app');
        assert.equal(row.text, PROFILE.description);
    });

    test('matches the Mastodon profile row schema exactly', () => {
        const EXPECTED_KEYS = [
            'platform', 'type', 'id', 'url', 'author', 'text', 'createdAt', 'language',
            'replies', 'reposts', 'likes', 'media', 'hashtags', 'mentions', 'inReplyTo',
            'isRepost', 'target', 'scrapedAt',
        ];
        assert.deepEqual(Object.keys(row), EXPECTED_KEYS);
    });

    test('author sub-object keys match Mastodon\'s', () => {
        assert.deepEqual(Object.keys(row.author), [
            'handle', 'displayName', 'url', 'followers', 'following',
            'postsCount', 'createdAt', 'bio', 'avatar',
        ]);
    });
});

describe('isReply / isRepostItem / timelineTime', () => {
    test('classify the fixture items consistently with their raw shape', () => {
        for (const item of FEED) {
            assert.equal(isRepostItem(item), item.reason?.$type === 'app.bsky.feed.defs#reasonRepost');
            assert.equal(isReply(item), Boolean(item.post.record.reply || item.reply));
        }
    });

    test('a repost sorts by the repost time, which is never earlier than the post', () => {
        const item = findItem(isRepostItem, 'a repost');
        assert.equal(timelineTime(item), Date.parse(item.reason.indexedAt));
        assert.ok(timelineTime(item) >= Date.parse(item.post.record.createdAt));
    });

    test('unparseable input degrades to 0 instead of NaN', () => {
        assert.equal(timelineTime({ post: { indexedAt: 'nope' } }), 0);
    });
});
