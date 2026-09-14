/**
 * Mastodon client + normalisation.
 *
 * Everything here rides the documented public REST API (docs.joinmastodon.org):
 *   GET /api/v1/accounts/lookup        resolve @user -> account
 *   GET /api/v1/accounts/:id/statuses  a profile's posts
 *   GET /api/v1/timelines/tag/:tag     a hashtag timeline
 *   GET /api/v1/statuses/:id           a single status
 *
 * None of these require a token on a default-configured instance. The endpoints that
 * DO require one (v2 search with resolve=true, remote lookups) are deliberately not used.
 */

import { fetchJson, parseNextLink, MASTODON_MIN_INTERVAL_MS } from './http.js';
import { htmlToText, makeAuthor, makeRow, toCount, toIso, unique } from './normalize.js';

/** Mastodon silently caps account/timeline pages at 40 items, so never ask for more. */
export const MASTODON_PAGE_LIMIT = 40;

/** True when `url` is a well-formed URL on exactly `origin`. */
export function sameOrigin(url, origin) {
    try {
        return new URL(url).origin === origin;
    } catch {
        return false;
    }
}

/**
 * Build the canonical `@user@instance` handle.
 * `acct` is bare for local accounts and `user@remote` for accounts the instance knows about.
 */
export function canonicalHandle(acct, instance) {
    if (!acct) return null;
    return acct.includes('@') ? `@${acct}` : `@${acct}@${instance}`;
}

/** Account object -> the shared author sub-object. */
export function normaliseAccount(account, instance) {
    if (!account) return null;
    return makeAuthor({
        handle: canonicalHandle(account.acct, instance),
        displayName: account.display_name || null,
        url: account.url || account.uri || null,
        followers: toCount(account.followers_count),
        following: toCount(account.following_count),
        postsCount: toCount(account.statuses_count),
        createdAt: toIso(account.created_at),
        bio: htmlToText(account.note),
        avatar: account.avatar || account.avatar_static || null,
    });
}

/** Account object -> a `type: "profile"` dataset row. */
export function normaliseProfileRow(account, { instance, target, includeRaw }) {
    const author = normaliseAccount(account, instance);
    return makeRow({
        platform: 'mastodon',
        type: 'profile',
        id: account.id,
        url: account.url || account.uri || null,
        author,
        text: author.bio,
        createdAt: toIso(account.created_at),
        language: null,
        media: account.avatar ? [{ url: account.avatar, type: 'image', alt: account.avatar_description || null }] : [],
        // Profile metadata fields (`fields[]`) often hold the user's own hashtags; the
        // bio's hashtags are the interesting signal, and they live in the note HTML.
        hashtags: [],
        mentions: [],
        target,
        raw: includeRaw ? account : undefined,
    });
}

function normaliseMedia(status, resolveMedia) {
    if (!resolveMedia) return [];
    return (status.media_attachments ?? []).map((attachment) => ({
        url: attachment.url || attachment.remote_url || null,
        type: attachment.type || 'unknown',
        alt: attachment.description || null,
    })).filter((item) => item.url);
}

/**
 * Status object -> a `type: "post"` dataset row.
 *
 * Boosts arrive as a hollow wrapper whose `reblog` holds the real content. We emit the
 * boosted content, credited to its original author, with `isRepost: true` and the
 * wrapper's own id so every row stays uniquely keyed.
 */
export function normaliseStatusRow(status, { instance, target, includeRaw, resolveMedia = true }) {
    const isRepost = Boolean(status.reblog);
    const content = status.reblog ?? status;
    const author = normaliseAccount(content.account, instance);

    return makeRow({
        platform: 'mastodon',
        type: 'post',
        id: status.id,
        url: content.url || content.uri || null,
        author,
        text: htmlToText(content.content),
        createdAt: toIso(content.created_at),
        language: content.language || null,
        replies: toCount(content.replies_count),
        reposts: toCount(content.reblogs_count),
        likes: toCount(content.favourites_count),
        media: normaliseMedia(content, resolveMedia),
        hashtags: unique((content.tags ?? []).map((tag) => tag.name)),
        mentions: unique((content.mentions ?? []).map((mention) => canonicalHandle(mention.acct, instance))),
        inReplyTo: content.in_reply_to_id ?? null,
        isRepost,
        target,
        raw: includeRaw ? status : undefined,
    });
}

/**
 * The timeline ordering time, which is when the status entered this feed -- the boost
 * time for a boost, the creation time otherwise. Used only to decide when to stop
 * paginating; never emitted. Because it is always >= the content's own createdAt,
 * stopping on it can never drop a post that `since` should have kept.
 */
export function timelineTime(status) {
    return Date.parse(status.created_at) || 0;
}

export class MastodonClient {
    /**
     * @param {object} options
     * @param {Function} [options.requestJson] Override the transport. Tests inject a stub
     *   here so pagination can be exercised without a network.
     */
    constructor({ limiter, userAgent, log, requestJson = fetchJson }) {
        this.limiter = limiter;
        this.userAgent = userAgent;
        this.log = log;
        this.requestJson = requestJson;
    }

    #request(url) {
        return this.requestJson(url, { limiter: this.limiter, userAgent: this.userAgent, log: this.log });
    }

    #get(instance, path, params = {}) {
        this.limiter.configure(instance, MASTODON_MIN_INTERVAL_MS);
        const url = new URL(`https://${instance}${path}`);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        return this.#request(url.toString());
    }

    /** Resolve `@user` on `instance` to a full account object. */
    async lookupAccount(instance, acct) {
        const { body } = await this.#get(instance, '/api/v1/accounts/lookup', { acct });
        return body;
    }

    async getStatus(instance, statusId) {
        const { body } = await this.#get(instance, `/api/v1/statuses/${encodeURIComponent(statusId)}`);
        return body;
    }

    /**
     * Walk a paginated collection via RFC 5988 `Link` headers, yielding statuses until
     * `shouldStop` says we are past the window the caller asked for.
     *
     * @param {(status: object) => boolean} shouldStop
     */
    async *paginate(instance, path, params, { shouldStop }) {
        this.limiter.configure(instance, MASTODON_MIN_INTERVAL_MS);
        const first = new URL(`https://${instance}${path}`);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) first.searchParams.set(key, String(value));
        }

        const origin = first.origin;
        let next = first.toString();
        while (next) {
            const { body, headers } = await this.#request(next);
            if (!Array.isArray(body) || body.length === 0) return;

            for (const status of body) {
                if (shouldStop(status)) return;
                yield status;
            }

            const link = parseNextLink(headers.get('link'));
            if (!link) return;
            // The Link header is written by the remote server. Following it blindly would
            // let any instance redirect our requests at an arbitrary host -- cloud metadata,
            // an internal service -- so pagination is pinned to the origin we started on.
            if (!sameOrigin(link, origin)) {
                this.log?.warning(`Ignoring cross-origin pagination link from ${origin} to ${link}`);
                return;
            }
            next = link;
        }
    }

    /**
     * A profile's posts. Replies and boosts are excluded server-side when not wanted,
     * which saves both bandwidth and rate-limit budget versus filtering locally.
     */
    accountStatuses(instance, accountId, { includeReplies, includeReposts, pageSize, shouldStop }) {
        return this.paginate(instance, `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`, {
            limit: Math.min(pageSize, MASTODON_PAGE_LIMIT),
            exclude_replies: includeReplies ? undefined : 'true',
            exclude_reblogs: includeReposts ? undefined : 'true',
        }, { shouldStop });
    }

    /** A hashtag timeline. The endpoint has no exclude params, so callers filter locally. */
    tagTimeline(instance, tag, { pageSize, shouldStop }) {
        return this.paginate(instance, `/api/v1/timelines/tag/${encodeURIComponent(tag)}`, {
            limit: Math.min(pageSize, MASTODON_PAGE_LIMIT),
        }, { shouldStop });
    }
}
