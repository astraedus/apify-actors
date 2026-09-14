/**
 * Bluesky client + normalisation, against the unauthenticated AppView
 * (https://public.api.bsky.app -- see docs.bsky.app).
 *
 * Endpoints used, all confirmed to serve anonymous requests:
 *   app.bsky.actor.getProfile        profile by handle or DID
 *   app.bsky.feed.getAuthorFeed      a profile's posts (cursor paginated)
 *   app.bsky.feed.getPosts           specific posts by at:// URI
 *   app.bsky.actor.searchActors      people search
 *   com.atproto.identity.resolveHandle  handle -> DID, to build at:// URIs
 *
 * app.bsky.feed.searchPosts is NOT used: Bluesky refuses it at the CDN edge for
 * unauthenticated datacenter traffic, and this Actor never accepts credentials.
 */

import { fetchJson, BLUESKY_MIN_INTERVAL_MS } from './http.js';
import { makeAuthor, makeRow, toCount, toIso, unique } from './normalize.js';

export const BLUESKY_APPVIEW_HOST = 'public.api.bsky.app';
/** getAuthorFeed and searchActors both cap at 100 per page. */
export const BLUESKY_PAGE_LIMIT = 100;
/** getPosts accepts at most 25 URIs in one call. */
export const BLUESKY_GET_POSTS_LIMIT = 25;

const REASON_REPOST = 'app.bsky.feed.defs#reasonRepost';
const FACET_TAG = 'app.bsky.richtext.facet#tag';
const FACET_MENTION = 'app.bsky.richtext.facet#mention';
const POST_COLLECTION = 'app.bsky.feed.post';

/** Valid `filter` values for getAuthorFeed. An unknown value is silently ignored by the API. */
export const AUTHOR_FEED_FILTERS = new Set([
    'posts_with_replies',
    'posts_no_replies',
    'posts_with_media',
    'posts_and_author_threads',
]);

/**
 * Slice `text` by a facet's byte range.
 *
 * Facet offsets are UTF-8 BYTE positions, not JS string indices, so any emoji or
 * non-ASCII character earlier in the post shifts them. Slicing the encoded buffer is
 * the only correct way to read them back.
 */
export function facetSlice(text, index) {
    if (!index || !Number.isFinite(index.byteStart) || !Number.isFinite(index.byteEnd)) return '';
    const bytes = Buffer.from(text ?? '', 'utf8');
    return bytes.subarray(index.byteStart, index.byteEnd).toString('utf8');
}

/** at:// URI -> the bsky.app permalink a human can open. */
export function postUrlFromUri(uri, handle) {
    if (!uri?.startsWith('at://')) return null;
    const [authority, collection, rkey] = uri.slice('at://'.length).split('/');
    if (collection !== POST_COLLECTION || !rkey) return null;
    return `https://bsky.app/profile/${handle || authority}/post/${rkey}`;
}

/** Profile or author view -> the shared author sub-object. */
export function normaliseActor(actor) {
    if (!actor) return null;
    return makeAuthor({
        handle: actor.handle ? `@${actor.handle}` : actor.did ?? null,
        displayName: actor.displayName || null,
        url: actor.handle ? `https://bsky.app/profile/${actor.handle}` : null,
        followers: toCount(actor.followersCount),
        following: toCount(actor.followsCount),
        postsCount: toCount(actor.postsCount),
        createdAt: toIso(actor.createdAt),
        bio: actor.description || '',
        avatar: actor.avatar || null,
    });
}

export function normaliseProfileRow(profile, { target, includeRaw }) {
    const author = normaliseActor(profile);
    return makeRow({
        platform: 'bluesky',
        type: 'profile',
        id: profile.did,
        url: author?.url ?? null,
        author,
        text: profile.description || '',
        createdAt: toIso(profile.createdAt),
        media: profile.avatar ? [{ url: profile.avatar, type: 'image', alt: null }] : [],
        target,
        raw: includeRaw ? profile : undefined,
    });
}

/**
 * Pull media out of any embed shape, including the recordWithMedia wrapper used when a
 * quote post also carries its own images. Quote embeds (`record#view`) hold no media.
 */
export function extractMedia(embed) {
    if (!embed) return [];
    switch (embed.$type) {
        case 'app.bsky.embed.images#view':
            return (embed.images ?? []).map((image) => ({
                url: image.fullsize || image.thumb || null,
                type: 'image',
                alt: image.alt || null,
            })).filter((item) => item.url);
        case 'app.bsky.embed.video#view':
            return embed.playlist
                ? [{ url: embed.playlist, type: 'video', alt: embed.alt || null }]
                : [];
        case 'app.bsky.embed.external#view':
            // A link card, not an upload -- surfaced so the linked URL is not lost.
            return embed.external?.uri
                ? [{
                    url: embed.external.uri,
                    type: 'external',
                    alt: embed.external.title || embed.external.description || null,
                }]
                : [];
        case 'app.bsky.embed.recordWithMedia#view':
            return extractMedia(embed.media);
        default:
            return [];
    }
}

/** Read hashtags and mentions out of the richtext facets (plus the legacy `tags` array). */
export function extractFacets(record) {
    const hashtags = [...(record?.tags ?? [])];
    const mentions = [];
    for (const facet of record?.facets ?? []) {
        for (const feature of facet.features ?? []) {
            if (feature.$type === FACET_TAG && feature.tag) {
                hashtags.push(feature.tag);
            } else if (feature.$type === FACET_MENTION) {
                // The DID is machine-readable but opaque; the handle is in the post text.
                const handle = facetSlice(record.text, facet.index);
                mentions.push(handle || feature.did);
            }
        }
    }
    return { hashtags: unique(hashtags), mentions: unique(mentions) };
}

/**
 * A feed item (or bare post view) -> a `type: "post"` row.
 *
 * A repost arrives as the original post plus a `reason` naming the reposter. We credit
 * the original author, key the row on the repost record so it stays unique, and set
 * `isRepost`.
 */
export function normalisePostRow(item, { target, includeRaw, resolveMedia = true }) {
    const post = item.post ?? item;
    const isRepost = item.reason?.$type === REASON_REPOST;
    const record = post.record ?? {};
    const author = normaliseActor(post.author);
    const { hashtags, mentions } = extractFacets(record);

    return makeRow({
        platform: 'bluesky',
        type: 'post',
        // The repost record has its own URI, so a post reposted twice yields two rows.
        id: isRepost ? item.reason.uri : post.uri,
        url: postUrlFromUri(post.uri, post.author?.handle),
        author,
        text: record.text ?? '',
        createdAt: toIso(record.createdAt ?? post.indexedAt),
        language: record.langs?.[0] ?? null,
        replies: toCount(post.replyCount),
        reposts: toCount(post.repostCount),
        likes: toCount(post.likeCount),
        media: resolveMedia ? extractMedia(post.embed) : [],
        hashtags,
        mentions,
        inReplyTo: record.reply?.parent?.uri ?? item.reply?.parent?.uri ?? null,
        isRepost,
        target,
        raw: includeRaw ? item : undefined,
    });
}

/** True when this feed item is a reply, whichever shape the API used to say so. */
export function isReply(item) {
    const post = item.post ?? item;
    return Boolean(post.record?.reply || item.reply);
}

export function isRepostItem(item) {
    return item.reason?.$type === REASON_REPOST;
}

/**
 * Timeline ordering time -- the repost time for a repost, indexing time otherwise.
 * Always >= the content's own createdAt, so stopping pagination on it can never drop a
 * post that `since` should have kept.
 */
export function timelineTime(item) {
    const post = item.post ?? item;
    const raw = item.reason?.indexedAt ?? post.indexedAt ?? post.record?.createdAt;
    return Date.parse(raw) || 0;
}

export class BlueskyClient {
    /**
     * @param {object} options
     * @param {Function} [options.requestJson] Override the transport. Tests inject a stub
     *   here so cursor pagination can be exercised without a network.
     */
    constructor({ limiter, userAgent, log, host = BLUESKY_APPVIEW_HOST, requestJson = fetchJson }) {
        this.limiter = limiter;
        this.userAgent = userAgent;
        this.log = log;
        this.host = host;
        this.requestJson = requestJson;
        this.limiter.configure(host, BLUESKY_MIN_INTERVAL_MS);
    }

    #get(method, params = {}) {
        const url = new URL(`https://${this.host}/xrpc/${method}`);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                for (const entry of value) url.searchParams.append(key, String(entry));
            } else {
                url.searchParams.set(key, String(value));
            }
        }
        return this.requestJson(url.toString(), {
            limiter: this.limiter, userAgent: this.userAgent, log: this.log,
        });
    }

    async getProfile(actor) {
        const { body } = await this.#get('app.bsky.actor.getProfile', { actor });
        return body;
    }

    async resolveHandle(handle) {
        const { body } = await this.#get('com.atproto.identity.resolveHandle', { handle });
        return body.did;
    }

    async getPosts(uris) {
        const { body } = await this.#get('app.bsky.feed.getPosts', {
            uris: uris.slice(0, BLUESKY_GET_POSTS_LIMIT),
        });
        return body.posts ?? [];
    }

    async searchActors(query, limit) {
        const { body } = await this.#get('app.bsky.actor.searchActors', {
            q: query,
            limit: Math.min(limit, BLUESKY_PAGE_LIMIT),
        });
        return body.actors ?? [];
    }

    /**
     * Walk an author feed with cursor pagination, stopping when `shouldStop` fires or
     * the server stops handing back a cursor.
     */
    async *authorFeed(actor, { filter, pageSize, shouldStop }) {
        const safeFilter = AUTHOR_FEED_FILTERS.has(filter) ? filter : 'posts_with_replies';
        let cursor;
        // An unchanged cursor would loop forever; Bluesky has been seen to repeat one.
        let previousCursor = null;

        for (;;) {
            const { body } = await this.#get('app.bsky.feed.getAuthorFeed', {
                actor,
                limit: Math.min(pageSize, BLUESKY_PAGE_LIMIT),
                filter: safeFilter,
                cursor,
            });
            const feed = body.feed ?? [];
            if (feed.length === 0) return;

            for (const item of feed) {
                if (shouldStop(item)) return;
                yield item;
            }

            cursor = body.cursor;
            if (!cursor || cursor === previousCursor) return;
            previousCursor = cursor;
        }
    }
}
