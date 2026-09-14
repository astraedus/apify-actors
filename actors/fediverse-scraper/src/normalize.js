/**
 * Shared row shape and text helpers.
 *
 * Both platforms emit rows with exactly the same keys, in the same order, so a
 * consumer can load the dataset straight into a table without reconciling schemas.
 * Fields that do not apply to a platform or row type are `null`, never absent --
 * a missing column and a genuinely empty one are different facts.
 */

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·',
};

/** Decode the HTML entities Mastodon actually emits, including numeric forms. */
export function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
        if (entity[0] === '#') {
            const isHex = entity[1] === 'x' || entity[1] === 'X';
            const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }
        const named = NAMED_ENTITIES[entity.toLowerCase()];
        return named ?? match;
    });
}

/**
 * Convert a Mastodon status/bio HTML body to plain text.
 *
 * Mastodon sanitises to a small tag set (p, br, a, span, del, pre, code, blockquote,
 * ul/ol/li), so a targeted converter beats a dependency here: block tags become line
 * breaks, everything else is dropped, then entities are decoded.
 */
export function htmlToText(html) {
    if (!html) return '';
    let text = String(html);

    // Block boundaries become newlines before tags are stripped, so paragraphs survive.
    text = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|blockquote|pre|h[1-6])\s*>/gi, '\n\n')
        // The opening <li> supplies the break, so </li> must not add a second one.
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(ul|ol)\s*>/gi, '\n')
        .replace(/<\/li\s*>/gi, '');

    text = text.replace(/<[^>]*>/g, '');
    text = decodeEntities(text);

    return text
        .replace(/\r\n?/g, '\n')
        // Trailing spaces before a newline are an artefact of tag removal.
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Normalise any timestamp the APIs hand us to a strict ISO-8601 string. */
export function toIso(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Coerce the count fields, which are absent rather than zero on some servers. */
export function toCount(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * The canonical dataset row. Every emitted item goes through this, which is what
 * makes `platform` the only column a consumer has to branch on.
 */
export function makeRow({
    platform,
    type,
    id,
    url = null,
    author = null,
    text = '',
    createdAt = null,
    language = null,
    replies = null,
    reposts = null,
    likes = null,
    media = [],
    hashtags = [],
    mentions = [],
    inReplyTo = null,
    isRepost = false,
    target = null,
    raw = undefined,
}) {
    const row = {
        platform,
        type,
        id,
        url,
        author,
        text,
        createdAt,
        language,
        replies,
        reposts,
        likes,
        media,
        hashtags,
        mentions,
        inReplyTo,
        isRepost,
        target,
        scrapedAt: new Date().toISOString(),
    };
    if (raw !== undefined) row.raw = raw;
    return row;
}

/** The author sub-object, identical in shape for both platforms. */
export function makeAuthor({
    handle,
    displayName = null,
    url = null,
    followers = null,
    following = null,
    postsCount = null,
    createdAt = null,
    bio = '',
    avatar = null,
}) {
    return { handle, displayName, url, followers, following, postsCount, createdAt, bio, avatar };
}

/** De-duplicate while preserving first-seen order (hashtags, mentions). */
export function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
