/**
 * Input normalisation.
 *
 * The Console applies the schema's defaults, but the Actor is also driven from the API
 * and from local `apify run`, where a caller may send a partial object. Defaults live
 * here so every entry point agrees, and so the defaults are unit-testable.
 */

import { DEFAULT_MASTODON_INSTANCE } from './targets.js';

export const MODES = ['profiles', 'posts', 'both'];

export const DEFAULT_TARGETS = [
    '@astraedus@mastodon.social',
    '@Gargron@mastodon.social',
    '#opensource@mastodon.social',
    'bsky.app',
];

export const DEFAULTS = {
    targets: DEFAULT_TARGETS,
    mode: 'both',
    // Deliberately small. This is the zero-config run Apify executes daily and grades on
    // a five-minute budget; it is also a trial user's first run, so it should be cheap.
    maxPostsPerTarget: 20,
    since: null,
    includeReplies: false,
    includeReposts: false,
    resolveMedia: true,
    includeRaw: false,
    defaultMastodonInstance: DEFAULT_MASTODON_INSTANCE,
    maxConcurrency: 4,
};

/** Bad input from the user; the run should fail fast and say exactly what is wrong. */
export class InputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InputError';
    }
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function positiveInt(value, fallback, { field, min = 1, max = Number.MAX_SAFE_INTEGER }) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new InputError(`"${field}" must be a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`);
    }
    return parsed;
}

/**
 * Parse the `since` cut-off. Accepts a plain date (2026-01-01) or a full timestamp.
 * A bare date means midnight UTC, which is the least surprising reading of "since".
 */
export function parseSince(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (raw === '') return null;
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
    if (!Number.isFinite(parsed)) {
        throw new InputError(`"since" is not a valid ISO date: ${JSON.stringify(value)}`);
    }
    if (parsed > Date.now()) {
        throw new InputError(`"since" is in the future (${new Date(parsed).toISOString()}); nothing could match it.`);
    }
    return parsed;
}

/** Apply defaults and validate. Throws InputError on anything unusable. */
export function normaliseInput(raw = {}) {
    const input = raw ?? {};

    let targets = input.targets ?? DEFAULTS.targets;
    if (typeof targets === 'string') {
        // Tolerate a newline/comma separated blob pasted into an API call.
        targets = targets.split(/[\n,]/);
    }
    if (!Array.isArray(targets)) {
        throw new InputError('"targets" must be an array of strings.');
    }
    targets = targets
        .map((entry) => (typeof entry === 'string' ? entry.trim() : entry?.url ?? ''))
        .filter((entry) => typeof entry === 'string' && entry.length > 0);
    if (targets.length === 0) {
        throw new InputError('"targets" is empty -- provide at least one profile, hashtag or post to scrape.');
    }

    const mode = input.mode ?? DEFAULTS.mode;
    if (!MODES.includes(mode)) {
        throw new InputError(`"mode" must be one of ${MODES.join(', ')}, got ${JSON.stringify(mode)}`);
    }

    return {
        targets,
        mode,
        maxPostsPerTarget: positiveInt(input.maxPostsPerTarget, DEFAULTS.maxPostsPerTarget, {
            field: 'maxPostsPerTarget', min: 1, max: 10_000,
        }),
        sinceMs: parseSince(input.since),
        includeReplies: bool(input.includeReplies, DEFAULTS.includeReplies),
        includeReposts: bool(input.includeReposts, DEFAULTS.includeReposts),
        resolveMedia: bool(input.resolveMedia, DEFAULTS.resolveMedia),
        includeRaw: bool(input.includeRaw, DEFAULTS.includeRaw),
        defaultMastodonInstance: (input.defaultMastodonInstance || DEFAULTS.defaultMastodonInstance)
            .trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        maxConcurrency: positiveInt(input.maxConcurrency, DEFAULTS.maxConcurrency, {
            field: 'maxConcurrency', min: 1, max: 10,
        }),
    };
}
