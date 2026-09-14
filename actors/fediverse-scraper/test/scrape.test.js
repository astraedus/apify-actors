import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scrapeTarget } from '../src/scrape.js';
import { parseTarget } from '../src/targets.js';
import { normaliseInput } from '../src/input.js';

const noopLog = { info() {}, warning() {}, error() {}, exception() {} };

/**
 * Minimal stand-ins for the two clients. They serve canned objects shaped like the real
 * APIs, so the filtering and mode rules can be exercised without a network.
 */
function makeClients({ mastodonStatuses = [], blueskyFeed = [] } = {}) {
    const account = {
        id: 'acct-1',
        acct: 'someone',
        display_name: 'Someone',
        url: 'https://mastodon.social/@someone',
        note: '<p>bio</p>',
        followers_count: 1,
        following_count: 2,
        statuses_count: 3,
        created_at: '2020-01-01T00:00:00.000Z',
        avatar: 'https://example.com/a.png',
    };
    const profile = {
        did: 'did:plc:abc',
        handle: 'someone.bsky.social',
        displayName: 'Someone',
        description: 'bio',
        followersCount: 1,
        followsCount: 2,
        postsCount: 3,
        createdAt: '2020-01-01T00:00:00.000Z',
    };

    return {
        mastodon: {
            lookupAccount: async () => account,
            getStatus: async () => mastodonStatuses[0],
            // The server-side exclude params are honoured by the real API; the stub returns
            // everything so the Actor's own filtering is what gets tested.
            async *accountStatuses() { yield* mastodonStatuses; },
            async *tagTimeline() { yield* mastodonStatuses; },
        },
        bluesky: {
            getProfile: async () => profile,
            resolveHandle: async () => profile.did,
            getPosts: async () => blueskyFeed.map((item) => item.post),
            searchActors: async () => [{ did: profile.did }],
            async *authorFeed() { yield* blueskyFeed; },
        },
    };
}

/** Mastodon status factory. */
const status = ({ id, replyTo = null, reblogOf = null, account = 'someone' }) => {
    const content = {
        id,
        created_at: '2026-09-01T00:00:00.000Z',
        content: `<p>post ${id}</p>`,
        in_reply_to_id: replyTo,
        account: { id: 'a', acct: account, display_name: account, url: 'u', note: '', created_at: '2020-01-01T00:00:00.000Z' },
        tags: [],
        mentions: [],
        media_attachments: [],
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
    };
    if (!reblogOf) return content;
    return { ...content, id, content: '', reblog: { ...content, id: reblogOf } };
};

/** Bluesky feed-item factory. */
const feedItem = ({ id, replyTo = null, repost = false }) => {
    const item = {
        post: {
            uri: `at://did:plc:abc/app.bsky.feed.post/${id}`,
            cid: id,
            author: { did: 'did:plc:abc', handle: 'someone.bsky.social', createdAt: '2020-01-01T00:00:00.000Z' },
            record: {
                text: `post ${id}`,
                createdAt: '2026-09-01T00:00:00.000Z',
                ...(replyTo ? { reply: { parent: { uri: replyTo }, root: { uri: replyTo } } } : {}),
            },
            replyCount: 0,
            repostCount: 0,
            likeCount: 0,
            indexedAt: '2026-09-01T00:00:00.000Z',
        },
    };
    if (repost) {
        item.reason = { $type: 'app.bsky.feed.defs#reasonRepost', uri: `at://r/${id}`, indexedAt: '2026-09-02T00:00:00.000Z' };
    }
    return item;
};

/** Run one target and collect the rows it emits. */
async function collect(targetString, rawInput, clients) {
    const input = normaliseInput(rawInput);
    const rows = [];
    await scrapeTarget(parseTarget(targetString), {
        clients,
        input,
        sinceMs: input.sinceMs,
        emit: async (row) => { rows.push(row); return true; },
        log: noopLog,
    });
    return rows;
}

const MASTODON_MIX = [
    status({ id: '1' }),
    status({ id: '2', replyTo: '99' }),
    status({ id: '3', reblogOf: 'orig' }),
];
const BLUESKY_MIX = [
    feedItem({ id: 'a' }),
    feedItem({ id: 'b', replyTo: 'at://x/app.bsky.feed.post/parent' }),
    feedItem({ id: 'c', repost: true }),
];

describe('includeReplies=false means the SAME thing on both platforms', () => {
    // Regression: Mastodon's exclude_replies=true still returns the author's replies to
    // themselves, so a real run leaked a thread continuation that Bluesky would have
    // dropped. A row carrying inReplyTo must never appear when replies are off.
    test('no Mastodon row has inReplyTo, including self-replies', async () => {
        const clients = makeClients({
            mastodonStatuses: [status({ id: '1' }), status({ id: '2', replyTo: '99' })],
        });
        const rows = await collect('@someone@mastodon.social', { mode: 'posts' }, clients);
        assert.deepEqual(rows.map((r) => r.id), ['1']);
        assert.equal(rows.every((r) => r.inReplyTo === null), true);
    });

    test('no Bluesky row has inReplyTo', async () => {
        const clients = makeClients({ blueskyFeed: BLUESKY_MIX });
        const rows = await collect('someone.bsky.social', { mode: 'posts' }, clients);
        assert.equal(rows.every((r) => r.inReplyTo === null), true);
    });

    test('a Mastodon hashtag timeline drops replies too', async () => {
        const clients = makeClients({ mastodonStatuses: MASTODON_MIX });
        const rows = await collect('#tag@mastodon.social', { mode: 'posts' }, clients);
        assert.equal(rows.every((r) => r.inReplyTo === null), true);
    });

    test('includeReplies=true lets them back in on both platforms', async () => {
        const mastodon = await collect('@someone@mastodon.social', { mode: 'posts', includeReplies: true },
            makeClients({ mastodonStatuses: MASTODON_MIX }));
        const bluesky = await collect('someone.bsky.social', { mode: 'posts', includeReplies: true },
            makeClients({ blueskyFeed: BLUESKY_MIX }));
        assert.ok(mastodon.some((r) => r.inReplyTo), 'Mastodon replies restored');
        assert.ok(bluesky.some((r) => r.inReplyTo), 'Bluesky replies restored');
    });
});

describe('includeReposts=false means the same thing on both platforms', () => {
    test('boosts and reposts are dropped by default', async () => {
        const mastodon = await collect('#tag@mastodon.social', { mode: 'posts' },
            makeClients({ mastodonStatuses: MASTODON_MIX }));
        const bluesky = await collect('someone.bsky.social', { mode: 'posts' },
            makeClients({ blueskyFeed: BLUESKY_MIX }));
        assert.equal(mastodon.some((r) => r.isRepost), false);
        assert.equal(bluesky.some((r) => r.isRepost), false);
    });

    test('includeReposts=true lets them back in on both platforms', async () => {
        const mastodon = await collect('#tag@mastodon.social', { mode: 'posts', includeReposts: true },
            makeClients({ mastodonStatuses: MASTODON_MIX }));
        const bluesky = await collect('someone.bsky.social', { mode: 'posts', includeReposts: true },
            makeClients({ blueskyFeed: BLUESKY_MIX }));
        assert.ok(mastodon.some((r) => r.isRepost), 'Mastodon boosts restored');
        assert.ok(bluesky.some((r) => r.isRepost), 'Bluesky reposts restored');
    });
});

describe('modes', () => {
    test('both: an account target yields one profile row plus its posts', async () => {
        for (const [target, clients] of [
            ['@someone@mastodon.social', makeClients({ mastodonStatuses: [status({ id: '1' })] })],
            ['someone.bsky.social', makeClients({ blueskyFeed: [feedItem({ id: 'a' })] })],
        ]) {
            const rows = await collect(target, { mode: 'both' }, clients);
            assert.equal(rows.filter((r) => r.type === 'profile').length, 1, target);
            assert.equal(rows.filter((r) => r.type === 'post').length, 1, target);
            assert.equal(rows[0].type, 'profile', 'the profile row comes first');
        }
    });

    test('posts: no profile row is emitted', async () => {
        const rows = await collect('@someone@mastodon.social', { mode: 'posts' },
            makeClients({ mastodonStatuses: [status({ id: '1' })] }));
        assert.equal(rows.some((r) => r.type === 'profile'), false);
    });

    test('profiles: no post row is emitted', async () => {
        const rows = await collect('@someone@mastodon.social', { mode: 'profiles' },
            makeClients({ mastodonStatuses: [status({ id: '1' })] }));
        assert.deepEqual(rows.map((r) => r.type), ['profile']);
    });

    test('both on a hashtag stays posts-only -- each row already embeds its author', async () => {
        const rows = await collect('#tag@mastodon.social', { mode: 'both' },
            makeClients({ mastodonStatuses: [status({ id: '1' })] }));
        assert.equal(rows.some((r) => r.type === 'profile'), false);
    });

    test('profiles on a hashtag returns the posting accounts, de-duplicated', async () => {
        const clients = makeClients({
            mastodonStatuses: [status({ id: '1' }), status({ id: '2' }), status({ id: '3' })],
        });
        const rows = await collect('#tag@mastodon.social', { mode: 'profiles' }, clients);
        assert.equal(rows.every((r) => r.type === 'profile'), true);
        assert.equal(rows.length, 1, 'three posts by one account is one profile row');
    });
});

describe('maxPostsPerTarget', () => {
    test('caps the rows emitted for a target', async () => {
        const many = Array.from({ length: 25 }, (_, i) => status({ id: String(i) }));
        const rows = await collect('@someone@mastodon.social', { mode: 'posts', maxPostsPerTarget: 5 },
            makeClients({ mastodonStatuses: many }));
        assert.equal(rows.length, 5);
    });

    test('applies on Bluesky too', async () => {
        const many = Array.from({ length: 25 }, (_, i) => feedItem({ id: `p${i}` }));
        const rows = await collect('someone.bsky.social', { mode: 'posts', maxPostsPerTarget: 3 },
            makeClients({ blueskyFeed: many }));
        assert.equal(rows.length, 3);
    });

    test('filtered-out rows do not consume the quota', async () => {
        // Replies are dropped before counting, so a reply-heavy feed still yields the
        // full number of real posts the user asked for.
        const mixed = [];
        for (let i = 0; i < 10; i += 1) {
            mixed.push(status({ id: `r${i}`, replyTo: '99' }));
            mixed.push(status({ id: `p${i}` }));
        }
        const rows = await collect('#tag@mastodon.social', { mode: 'posts', maxPostsPerTarget: 4 },
            makeClients({ mastodonStatuses: mixed }));
        assert.equal(rows.length, 4);
        assert.equal(rows.every((r) => r.inReplyTo === null), true);
    });
});

describe('single-post and search targets', () => {
    test('a Mastodon post target emits exactly one row', async () => {
        const rows = await collect('https://mastodon.social/@someone/1', { mode: 'both' },
            makeClients({ mastodonStatuses: [status({ id: '1' })] }));
        assert.deepEqual(rows.map((r) => r.type), ['post']);
    });

    test('a Bluesky post target emits exactly one row', async () => {
        const rows = await collect('https://bsky.app/profile/someone.bsky.social/post/a', { mode: 'both' },
            makeClients({ blueskyFeed: [feedItem({ id: 'a' })] }));
        assert.deepEqual(rows.map((r) => r.type), ['post']);
    });

    test('actor search emits profile rows', async () => {
        const rows = await collect('bsky:actors:someone', { mode: 'profiles' }, makeClients());
        assert.deepEqual(rows.map((r) => r.type), ['profile']);
    });

    test('actor search in posts-only mode emits nothing rather than failing', async () => {
        const rows = await collect('bsky:actors:someone', { mode: 'posts' }, makeClients());
        assert.deepEqual(rows, []);
    });
});

describe('since', () => {
    test('stops the feed once the timeline passes the cut-off', async () => {
        const old = { ...status({ id: 'old' }), created_at: '2020-01-01T00:00:00.000Z' };
        const recent = { ...status({ id: 'new' }), created_at: '2026-09-01T00:00:00.000Z' };
        const rows = await collect('#tag@mastodon.social', { mode: 'posts', since: '2026-01-01' },
            makeClients({ mastodonStatuses: [recent, old] }));
        assert.deepEqual(rows.map((r) => r.id), ['new']);
    });
});
