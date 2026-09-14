/**
 * Platform-agnostic orchestration: one parsed target in, normalised rows out.
 *
 * The clients know how to talk to each API and the normalisers know how to shape a row;
 * this module owns the rules that are the same on both platforms -- what `mode` means,
 * how `since` interacts with pagination, and how many rows a target may produce.
 */

import { describeTarget } from './targets.js';
import * as mastodon from './mastodon.js';
import * as bluesky from './bluesky.js';

/** Rows a hashtag/post target may emit in each mode. See README "Modes". */
const wantsProfiles = (mode) => mode === 'profiles' || mode === 'both';
const wantsPosts = (mode) => mode === 'posts' || mode === 'both';

/**
 * The per-target quota and date window, enforced on BOTH sides of the iterator.
 *
 * `shouldStop` lets the client stop fetching pages early, which is the optimisation.
 * `allows` and `isFull` re-check the same rules as rows are consumed, which is the
 * guarantee: the user pays per row, so a client that ignored `shouldStop` -- or a feed
 * that came back out of order -- must not be able to over-deliver and over-bill.
 */
function makeGate({ sinceMs, limit, counter, timeOf }) {
    const tooOld = (item) => Boolean(sinceMs) && timeOf(item) < sinceMs;
    return {
        shouldStop: (item) => counter.emitted >= limit || tooOld(item),
        allows: (item) => counter.emitted < limit && !tooOld(item),
        isFull: () => counter.emitted >= limit,
    };
}

async function scrapeMastodonProfile(target, ctx) {
    const { client, input, emit, log } = ctx;
    const account = await client.lookupAccount(target.instance, target.acct);

    if (wantsProfiles(input.mode)) {
        await emit(mastodon.normaliseProfileRow(account, {
            instance: target.instance, target: target.raw, includeRaw: input.includeRaw,
        }));
    }
    if (!wantsPosts(input.mode)) return;

    const counter = { emitted: 0 };
    const gate = makeGate({
        sinceMs: ctx.sinceMs, limit: input.maxPostsPerTarget, counter, timeOf: mastodon.timelineTime,
    });

    for await (const status of client.accountStatuses(target.instance, account.id, {
        includeReplies: input.includeReplies,
        includeReposts: input.includeReposts,
        pageSize: input.maxPostsPerTarget,
        shouldStop: gate.shouldStop,
    })) {
        if (gate.isFull()) break;
        if (!gate.allows(status)) continue;
        // Mastodon's exclude_replies still returns the author's replies to THEMSELVES
        // (thread continuations), while Bluesky's posts_no_replies drops them. Filtering
        // here keeps one promise on both platforms: includeReplies=false means no row
        // has inReplyTo set. The server-side param stays, because it saves a lot of pages.
        if (!input.includeReplies && (status.reblog ?? status).in_reply_to_id) continue;

        const row = mastodon.normaliseStatusRow(status, {
            instance: target.instance,
            target: target.raw,
            includeRaw: input.includeRaw,
            resolveMedia: input.resolveMedia,
        });
        if (await emit(row)) counter.emitted += 1;
    }
    log.info(`${describeTarget(target)}: ${counter.emitted} posts`);
}

async function scrapeMastodonHashtag(target, ctx) {
    const { client, input, emit, log } = ctx;
    const counter = { emitted: 0 };
    const gate = makeGate({
        sinceMs: ctx.sinceMs, limit: input.maxPostsPerTarget, counter, timeOf: mastodon.timelineTime,
    });
    // A hashtag has no single subject account, so `profiles` mode reports the people
    // posting under it instead. `both` stays posts-only -- each row already embeds its author.
    const profilesOnly = input.mode === 'profiles';
    const seenAccounts = new Set();

    for await (const status of client.tagTimeline(target.instance, target.tag, {
        pageSize: input.maxPostsPerTarget,
        shouldStop: gate.shouldStop,
    })) {
        if (gate.isFull()) break;
        if (!gate.allows(status)) continue;
        // The tag timeline endpoint has no exclude_* params, so filter here.
        const isRepost = Boolean(status.reblog);
        const content = status.reblog ?? status;
        if (!input.includeReposts && isRepost) continue;
        if (!input.includeReplies && content.in_reply_to_id) continue;

        if (profilesOnly) {
            const account = content.account;
            if (!account || seenAccounts.has(account.id)) continue;
            seenAccounts.add(account.id);
            if (await emit(mastodon.normaliseProfileRow(account, {
                instance: target.instance, target: target.raw, includeRaw: input.includeRaw,
            }))) counter.emitted += 1;
            continue;
        }

        const row = mastodon.normaliseStatusRow(status, {
            instance: target.instance,
            target: target.raw,
            includeRaw: input.includeRaw,
            resolveMedia: input.resolveMedia,
        });
        if (await emit(row)) counter.emitted += 1;
    }
    log.info(`${describeTarget(target)}: ${counter.emitted} ${profilesOnly ? 'profiles' : 'posts'}`);
}

async function scrapeMastodonPost(target, ctx) {
    const { client, input, emit } = ctx;
    const status = await client.getStatus(target.instance, target.statusId);
    if (input.mode === 'profiles') {
        const account = (status.reblog ?? status).account;
        await emit(mastodon.normaliseProfileRow(account, {
            instance: target.instance, target: target.raw, includeRaw: input.includeRaw,
        }));
        return;
    }
    await emit(mastodon.normaliseStatusRow(status, {
        instance: target.instance,
        target: target.raw,
        includeRaw: input.includeRaw,
        resolveMedia: input.resolveMedia,
    }));
}

async function scrapeBlueskyProfile(target, ctx) {
    const { client, input, emit, log } = ctx;
    const profile = await client.getProfile(target.actor);

    if (wantsProfiles(input.mode)) {
        await emit(bluesky.normaliseProfileRow(profile, {
            target: target.raw, includeRaw: input.includeRaw,
        }));
    }
    if (!wantsPosts(input.mode)) return;

    const counter = { emitted: 0 };
    const gate = makeGate({
        sinceMs: ctx.sinceMs, limit: input.maxPostsPerTarget, counter, timeOf: bluesky.timelineTime,
    });

    for await (const item of client.authorFeed(profile.did || target.actor, {
        // Replies can be excluded server-side; reposts cannot, so they are filtered below.
        filter: input.includeReplies ? 'posts_with_replies' : 'posts_no_replies',
        pageSize: input.maxPostsPerTarget,
        shouldStop: gate.shouldStop,
    })) {
        if (gate.isFull()) break;
        if (!gate.allows(item)) continue;
        if (!input.includeReposts && bluesky.isRepostItem(item)) continue;
        if (!input.includeReplies && bluesky.isReply(item)) continue;
        const row = bluesky.normalisePostRow(item, {
            target: target.raw, includeRaw: input.includeRaw, resolveMedia: input.resolveMedia,
        });
        if (await emit(row)) counter.emitted += 1;
    }
    log.info(`${describeTarget(target)}: ${counter.emitted} posts`);
}

async function scrapeBlueskyPost(target, ctx) {
    const { client, input, emit } = ctx;
    // A permalink gives us a handle and a record key; the at:// URI needs the DID.
    let uri = target.uri;
    if (!uri) {
        const did = target.actor.startsWith('did:')
            ? target.actor
            : await client.resolveHandle(target.actor);
        uri = `at://${did}/app.bsky.feed.post/${target.rkey}`;
    }
    const posts = await client.getPosts([uri]);
    for (const post of posts) {
        if (input.mode === 'profiles') {
            const profile = await client.getProfile(post.author.did);
            await emit(bluesky.normaliseProfileRow(profile, {
                target: target.raw, includeRaw: input.includeRaw,
            }));
            continue;
        }
        await emit(bluesky.normalisePostRow(post, {
            target: target.raw, includeRaw: input.includeRaw, resolveMedia: input.resolveMedia,
        }));
    }
}

async function scrapeBlueskyActorSearch(target, ctx) {
    const { client, input, emit, log } = ctx;
    if (!wantsProfiles(input.mode)) {
        log.warning(`${describeTarget(target)}: skipped, actor search only produces profiles (mode is "${input.mode}")`);
        return;
    }
    const actors = await client.searchActors(target.query, input.maxPostsPerTarget);
    let emitted = 0;
    for (const actor of actors) {
        // searchActors returns the compact view; fetch the full profile for the counts.
        const profile = await client.getProfile(actor.did);
        if (await emit(bluesky.normaliseProfileRow(profile, {
            target: target.raw, includeRaw: input.includeRaw,
        }))) emitted += 1;
    }
    log.info(`${describeTarget(target)}: ${emitted} profiles`);
}

const HANDLERS = {
    'mastodon:profile': scrapeMastodonProfile,
    'mastodon:hashtag': scrapeMastodonHashtag,
    'mastodon:post': scrapeMastodonPost,
    'bluesky:profile': scrapeBlueskyProfile,
    'bluesky:post': scrapeBlueskyPost,
    'bluesky:actor-search': scrapeBlueskyActorSearch,
};

/**
 * Scrape one parsed target.
 *
 * @param {object} target        from parseTarget()
 * @param {object} ctx           { clients, input, sinceMs, emit, log }
 * @param {(row: object) => Promise<boolean>} ctx.emit
 *        Pushes a row; returns false when the row was a duplicate and was dropped.
 */
export async function scrapeTarget(target, ctx) {
    const handler = HANDLERS[`${target.platform}:${target.kind}`];
    if (!handler) throw new Error(`No handler for ${target.platform}/${target.kind}`);
    const client = ctx.clients[target.platform];
    return handler(target, { ...ctx, client });
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 * Per-host pacing lives in the RateLimiter, so this only bounds parallel targets.
 */
export async function pool(items, concurrency, worker) {
    const queue = [...items.entries()];
    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        for (;;) {
            const next = queue.shift();
            if (!next) return;
            const [index, item] = next;
            await worker(item, index);
        }
    });
    await Promise.all(runners);
}
