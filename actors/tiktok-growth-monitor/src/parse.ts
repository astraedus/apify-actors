/**
 * Parsing and validation of the user-supplied `profiles` input.
 *
 * Users paste whatever they have: bare handles, @handles, profile URLs, even a
 * link to a single video. All of it has to collapse to one canonical username
 * so that snapshots taken across runs line up on the same key.
 */

/**
 * TikTok usernames are 2-24 chars of letters, digits, underscore and period.
 * We accept a slightly wider length range than TikTok documents, because
 * rejecting a real handle is far worse than passing a dud through to the base
 * actor (which will simply return nothing for it).
 */
const USERNAME_RE = /^[A-Za-z0-9._]{1,32}$/;

/** Matches `/@handle` anywhere in a tiktok.com path, ignoring any `/video/123` tail. */
const URL_HANDLE_RE = /(?:^|\/)@([A-Za-z0-9._]{1,32})(?:[/?#]|$)/;

/**
 * Collapse one raw input entry to a canonical lowercase username.
 *
 * TikTok handles are case-insensitive for lookup but are echoed back by the API
 * in their display casing, so we lowercase for keying and matching. Returns null
 * for anything we cannot confidently read as a handle.
 */
export function parseUsername(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;

    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    // Any tiktok.com URL (with or without scheme) -> pull the @handle out of the path.
    if (/tiktok\.com/i.test(trimmed)) {
        const match = URL_HANDLE_RE.exec(trimmed);
        return match ? match[1].toLowerCase() : null;
    }

    // Bare handle, optionally @-prefixed.
    const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    if (!USERNAME_RE.test(bare)) return null;

    return bare.toLowerCase();
}

/** The canonical public profile URL the base scraper expects. */
export function profileUrl(username: string): string {
    return `https://www.tiktok.com/@${username}`;
}

export interface ParsedProfiles {
    /** Canonical, lowercased, de-duplicated, in first-seen order. */
    usernames: string[];
    /** Raw entries we could not read as a handle, preserved verbatim for the log. */
    invalid: string[];
}

/**
 * Parse the whole `profiles` input array.
 *
 * De-duplicates, because a user listing both `@tiktok` and
 * `https://www.tiktok.com/@tiktok` must not be billed twice for one profile.
 */
export function parseProfiles(raw: unknown): ParsedProfiles {
    const entries = Array.isArray(raw) ? raw : [];
    const usernames: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        const username = parseUsername(entry);
        if (username === null) {
            invalid.push(typeof entry === 'string' ? entry : JSON.stringify(entry));
            continue;
        }
        if (seen.has(username)) continue;
        seen.add(username);
        usernames.push(username);
    }

    return { usernames, invalid };
}

/**
 * Key-value store keys allow `a-zA-Z0-9!-_.'()`, which is a superset of the
 * TikTok username charset — but we prefix and guard anyway so a future input
 * relaxation cannot produce an unwritable key.
 */
export function snapshotKey(username: string): string {
    return `profile-${username.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
