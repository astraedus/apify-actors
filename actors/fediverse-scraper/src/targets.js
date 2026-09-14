/**
 * Target parsing: one user-supplied string in, one structured target out.
 *
 * Users paste whatever they have to hand -- a fediverse address, a profile URL, a
 * permalink, an at:// URI, a bare Bluesky handle -- so detection has to be ordered
 * and unambiguous. Every rule below is pinned by a test in test/targets.test.js.
 */

import { assertPublicHost, isPublicHostname, UnsafeHostError } from './hosts.js';

export const DEFAULT_MASTODON_INSTANCE = 'mastodon.social';

/** Bad input from the user, not a bug and not a transient failure. */
export class TargetError extends Error {
    constructor(message, { raw, supported = true } = {}) {
        super(message);
        this.name = 'TargetError';
        this.raw = raw;
        /** False when the target is well-formed but the platform does not expose it publicly. */
        this.supported = supported;
    }
}

/**
 * Bluesky serves profiles and author feeds to anonymous clients, but its post-search
 * endpoint is refused at the CDN edge for unauthenticated datacenter traffic. We do
 * not accept login credentials, so search targets are rejected with a clear reason
 * rather than failing mysteriously at request time.
 */
const BLUESKY_SEARCH_UNSUPPORTED =
    'Bluesky keyword/hashtag search is not supported: Bluesky refuses unauthenticated '
    + 'app.bsky.feed.searchPosts requests from datacenter IPs, and this Actor never asks for '
    + 'your password. Use a Bluesky handle or post URL instead, or use a Mastodon hashtag '
    + 'target such as "#opensource@mastodon.social".';

const BSKY_WEB_HOSTS = new Set(['bsky.app', 'staging.bsky.app', 'main.bsky.dev']);
const AT_POST_COLLECTION = 'app.bsky.feed.post';

const isDid = (value) => /^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(value);
const isDigits = (value) => /^\d+$/.test(value);

/**
 * Canonicalise and validate a Mastodon instance host.
 *
 * Validation must happen on the CANONICAL hostname, because `new URL()` rewrites
 * alternate IPv4 notations -- `0xa9.0xfe.0xa9.0xfe` and `127.1` both become real
 * addresses -- and any check applied to the raw string is bypassed by those encodings.
 * `src/hosts.js` owns the rule; here we only translate a failure into a TargetError.
 */
function safeInstance(rawHost, raw) {
    try {
        return assertPublicHost(rawHost, `"${raw}"`);
    } catch (error) {
        if (error instanceof UnsafeHostError) throw new TargetError(error.message, { raw });
        throw error;
    }
}

/** A Bluesky handle is a domain name. It is sent as a query parameter, never used as a host. */
const isHostShaped = (value) =>
    /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value);
const looksLikeBlueskyHandle = isHostShaped;
/** Mastodon usernames are letters, digits, underscore and (for remote accts) dots/hyphens. */
const isUsername = (value) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
/** Mastodon hashtags are alphanumeric plus underscore -- no spaces, slashes or punctuation. */
const isHashtag = (value) => /^[\p{L}\p{N}_]+$/u.test(value);

const stripLeading = (value, char) => (value.startsWith(char) ? value.slice(1) : value);

/** Hostnames are case-insensitive; usernames and tags are not, so only lowercase the host. */
const normaliseInstance = (host) => host.trim().toLowerCase().replace(/^www\./, '');

/**
 * Reject URLs we must never turn into an outbound request: non-HTTPS schemes, embedded
 * credentials (`https://user:pass@host/`), explicit ports, and hosts that point inside
 * our own infrastructure. `targets` is fully user-controlled, so this is the boundary
 * between "scrape a fediverse server" and "make the Actor fetch whatever I name".
 */
function assertSafeUrl(url, raw) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new TargetError(`Only http(s) URLs are supported, got "${url.protocol}" in "${raw}"`, { raw });
    }
    if (url.username || url.password) {
        throw new TargetError(`URLs with embedded credentials are not accepted: "${raw}"`, { raw });
    }
    if (url.port) {
        throw new TargetError(`URLs with an explicit port are not accepted: "${raw}"`, { raw });
    }
    // url.hostname is already canonical, so every IPv4 encoding collapses here.
    if (!isPublicHostname(url.hostname)) {
        throw new TargetError(`"${url.hostname}" is not a valid public instance host in "${raw}"`, { raw });
    }
}

function blueskyProfile(actor, raw) {
    return { raw, platform: 'bluesky', kind: 'profile', actor };
}

function blueskyPost({ actor, rkey, uri }, raw) {
    return { raw, platform: 'bluesky', kind: 'post', actor, rkey, uri: uri ?? null };
}

function mastodonProfile(instance, acct, raw) {
    return { raw, platform: 'mastodon', kind: 'profile', instance, acct };
}

function mastodonHashtag(instance, tag, raw) {
    return { raw, platform: 'mastodon', kind: 'hashtag', instance, tag };
}

function mastodonPost(instance, statusId, raw) {
    return { raw, platform: 'mastodon', kind: 'post', instance, statusId };
}

/** Parse `at://<authority>/<collection>/<rkey>`. */
function parseAtUri(value, raw) {
    const rest = value.slice('at://'.length);
    const [authority, collection, rkey] = rest.split('/');
    if (!authority) throw new TargetError(`Malformed at:// URI: "${raw}"`, { raw });
    if (!collection) return blueskyProfile(authority, raw);
    if (collection !== AT_POST_COLLECTION) {
        throw new TargetError(
            `Unsupported at:// collection "${collection}" in "${raw}" (only ${AT_POST_COLLECTION} is supported)`,
            { raw, supported: false },
        );
    }
    if (!rkey) throw new TargetError(`at:// post URI is missing a record key: "${raw}"`, { raw });
    return blueskyPost({ actor: authority, rkey, uri: `at://${authority}/${collection}/${rkey}` }, raw);
}

function parseBlueskyWebUrl(url, raw) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'hashtag' || segments[0] === 'search') {
        throw new TargetError(BLUESKY_SEARCH_UNSUPPORTED, { raw, supported: false });
    }
    if (segments[0] !== 'profile' || !segments[1]) {
        throw new TargetError(`Unrecognised Bluesky URL: "${raw}"`, { raw });
    }
    const actor = decodeURIComponent(segments[1]);
    if (segments[2] === 'post' && segments[3]) {
        return blueskyPost({ actor, rkey: segments[3] }, raw);
    }
    return blueskyProfile(actor, raw);
}

function parseMastodonWebUrl(url, raw) {
    assertSafeUrl(url, raw);
    const instance = normaliseInstance(url.hostname);
    // Some instances serve the deck UI under /deck/<normal path>.
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'deck') segments.shift();

    if (segments[0] === 'tags' && segments[1]) {
        return mastodonHashtag(instance, decodeURIComponent(stripLeading(segments[1], '#')), raw);
    }
    // /@user  and  /@user/<statusId>
    if (segments[0]?.startsWith('@')) {
        const acct = decodeURIComponent(segments[0].slice(1));
        if (!acct) throw new TargetError(`Mastodon URL is missing a username: "${raw}"`, { raw });
        if (segments[1] && isDigits(segments[1])) return mastodonPost(instance, segments[1], raw);
        return mastodonProfile(instance, acct, raw);
    }
    // /users/<user>  and  /users/<user>/statuses/<id>
    if (segments[0] === 'users' && segments[1]) {
        if (segments[2] === 'statuses' && isDigits(segments[3] ?? '')) {
            return mastodonPost(instance, segments[3], raw);
        }
        return mastodonProfile(instance, decodeURIComponent(segments[1]), raw);
    }
    throw new TargetError(
        `Unrecognised URL: "${raw}". Expected a profile (https://instance/@user), `
        + 'a post permalink, or a hashtag page (https://instance/tags/topic).',
        { raw },
    );
}

function parseUrl(value, raw) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new TargetError(`Could not parse "${raw}" as a URL`, { raw });
    }
    if (BSKY_WEB_HOSTS.has(normaliseInstance(url.host))) return parseBlueskyWebUrl(url, raw);
    return parseMastodonWebUrl(url, raw);
}

/** Body of a `bsky:` / `bluesky:` prefixed target -- forced to the Bluesky platform. */
function parseBlueskyForced(body, raw) {
    if (!body) throw new TargetError(`Empty Bluesky target in "${raw}"`, { raw });
    if (body.startsWith('at://')) return parseAtUri(body, raw);
    if (/^https?:\/\//i.test(body)) return parseUrl(body, raw);
    if (body.startsWith('#')) throw new TargetError(BLUESKY_SEARCH_UNSUPPORTED, { raw, supported: false });

    // Explicit people-search: `bsky:actors:<query>` uses app.bsky.actor.searchActors,
    // which -- unlike post search -- is served to anonymous clients.
    const actorSearch = body.match(/^actors?:(.+)$/i);
    if (actorSearch) {
        const query = actorSearch[1].trim();
        if (!query) throw new TargetError(`Empty actor-search query in "${raw}"`, { raw });
        return { raw, platform: 'bluesky', kind: 'actor-search', query };
    }

    const handle = stripLeading(body, '@');
    if (isDid(handle) || looksLikeBlueskyHandle(handle)) return blueskyProfile(handle, raw);
    throw new TargetError(BLUESKY_SEARCH_UNSUPPORTED, { raw, supported: false });
}

/** Body of a `mastodon:` prefixed target -- forced to the Mastodon platform. */
function parseMastodonForced(body, raw, defaultInstance) {
    if (!body) throw new TargetError(`Empty Mastodon target in "${raw}"`, { raw });
    if (/^https?:\/\//i.test(body)) return parseMastodonWebUrl(new URL(body), raw);
    return parseFediverseAddress(body, raw, defaultInstance);
}

/**
 * `#tag@instance`, `#tag`, `@user@instance`, `user@instance`.
 *
 * The username and instance are validated rather than merely split on `@`: without that,
 * a string like `ftp://example.com/@user` splits into two non-empty halves and would be
 * accepted as the account "ftp://example.com/" on the instance "user".
 */
function parseFediverseAddress(value, raw, defaultInstance) {
    if (value.startsWith('#')) {
        const [tag, instance] = value.slice(1).split('@');
        if (!tag) throw new TargetError(`Empty hashtag in "${raw}"`, { raw });
        if (!isHashtag(tag)) {
            throw new TargetError(`"${tag}" is not a valid hashtag (letters, digits and _ only) in "${raw}"`, { raw });
        }
        return mastodonHashtag(safeInstance(normaliseInstance(instance || defaultInstance), raw), tag, raw);
    }

    const parts = stripLeading(value, '@').split('@');
    const [username, instance] = parts.length === 2 ? parts : [parts[0], defaultInstance];
    if (parts.length > 2 || !username) {
        throw new TargetError(`Unrecognised Mastodon address: "${raw}"`, { raw });
    }
    if (!isUsername(username)) {
        throw new TargetError(`"${username}" is not a valid Mastodon username in "${raw}"`, { raw });
    }
    return mastodonProfile(safeInstance(normaliseInstance(instance), raw), username, raw);
}

/**
 * Turn one user-supplied target string into a structured target.
 *
 * @param {string} input
 * @param {{ defaultMastodonInstance?: string }} [options]
 * @throws {TargetError} when the string is unrecognised or names a capability the
 *   platform does not expose to anonymous clients.
 */
export function parseTarget(input, { defaultMastodonInstance = DEFAULT_MASTODON_INSTANCE } = {}) {
    if (typeof input !== 'string') throw new TargetError(`Target must be a string, got ${typeof input}`, { raw: input });
    const raw = input.trim();
    if (!raw) throw new TargetError('Target is empty', { raw: input });

    const prefixed = raw.match(/^(mastodon|bluesky|bsky):(.*)$/is);
    if (prefixed) {
        const [, platform, body] = prefixed;
        const trimmedBody = body.trim();
        return platform.toLowerCase() === 'mastodon'
            ? parseMastodonForced(trimmedBody, raw, defaultMastodonInstance)
            : parseBlueskyForced(trimmedBody, raw);
    }

    if (raw.startsWith('at://')) return parseAtUri(raw, raw);
    if (/^https?:\/\//i.test(raw)) return parseUrl(raw, raw);
    if (isDid(raw)) return blueskyProfile(raw, raw);
    if (raw.startsWith('#')) return parseFediverseAddress(raw, raw, defaultMastodonInstance);

    const atCount = (raw.match(/@/g) || []).length;
    // A full fediverse address always carries an instance: @user@host or user@host.
    if (atCount === 2 && raw.startsWith('@')) return parseFediverseAddress(raw, raw, defaultMastodonInstance);
    if (atCount === 1 && !raw.startsWith('@')) return parseFediverseAddress(raw, raw, defaultMastodonInstance);
    // A single leading @ over a domain-shaped name is a Bluesky handle (@alice.bsky.social).
    if (atCount === 1 && raw.startsWith('@')) {
        const handle = raw.slice(1);
        if (looksLikeBlueskyHandle(handle)) return blueskyProfile(handle, raw);
        throw new TargetError(
            `Ambiguous target "${raw}": a Mastodon account needs its instance (@user@instance), `
            + 'and a Bluesky handle needs a domain (alice.bsky.social).',
            { raw },
        );
    }
    if (looksLikeBlueskyHandle(raw)) return blueskyProfile(raw, raw);

    throw new TargetError(
        `Unrecognised target "${raw}". Supported forms: @user@instance, #tag@instance, `
        + 'a profile or post URL, a Bluesky handle (alice.bsky.social), a did:plc:... or an at:// URI.',
        { raw },
    );
}

/** Human-readable label used in logs and in the `target` column of every row. */
export function describeTarget(target) {
    switch (target.platform) {
        case 'mastodon':
            if (target.kind === 'hashtag') return `mastodon #${target.tag}@${target.instance}`;
            if (target.kind === 'post') return `mastodon status ${target.statusId}@${target.instance}`;
            return `mastodon @${target.acct}@${target.instance}`;
        case 'bluesky':
            if (target.kind === 'actor-search') return `bluesky actor search "${target.query}"`;
            if (target.kind === 'post') return `bluesky post ${target.rkey} by ${target.actor}`;
            return `bluesky ${target.actor}`;
        default:
            return JSON.stringify(target);
    }
}
