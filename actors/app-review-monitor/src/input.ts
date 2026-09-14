/**
 * Input parsing and validation.
 *
 * Kept pure (no SDK calls) so the whole contract — including every default —
 * is unit-testable, and so a bad input fails with one clear message before a
 * single network request or charge happens.
 */

import { DEFAULT_STATE_STORE_NAME } from './state.ts';

/**
 * Zero-config defaults. These are the values the Store's "Start" button runs
 * with, so they must always produce rows inside Apify's 5-minute automated test.
 *
 * Three of our own Android apps plus Facebook on the App Store: the Facebook
 * entry both exercises the Apple code path and guarantees a non-empty result on
 * every run, because a top-10 app gathers new US reviews continuously — a
 * monitor whose default run went empty after day one would look broken.
 */
export const DEFAULT_APPS = [
    'dev.astraedus.nudge',
    'com.raeduslabs.origo',
    'com.raeduslabs.soulsyncapp',
    '284882215',
] as const;

export const DEFAULT_COUNTRIES = ['us'] as const;
export const DEFAULT_MAX_REVIEWS_PER_APP = 200;

/** Hard ceiling per app+country; protects both runtime and the user's bill. */
export const MAX_REVIEWS_LIMIT = 1000;
export const MAX_APPS = 100;

export interface ParsedInput {
    apps: string[];
    countries: string[];
    maxReviewsPerApp: number;
    onlyNew: boolean;
    minRating: number | null;
    maxRating: number | null;
    webhookUrl: string | null;
    stateStoreName: string;
    resetState: boolean;
}

export type RawInput = Record<string, unknown> | null | undefined;

function asStringArray(value: unknown, field: string): string[] | null {
    if (value == null) return null;
    if (typeof value === 'string') {
        // Tolerate a newline/comma separated paste, which is what people do.
        const items = value
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
        return items.length > 0 ? items : null;
    }
    if (!Array.isArray(value)) {
        throw new Error(`\`${field}\` must be an array of strings.`);
    }
    const items = value.map((v) => String(v).trim()).filter(Boolean);
    return items.length > 0 ? items : null;
}

function asRating(value: unknown, field: string): number | null {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 5) {
        throw new Error(`\`${field}\` must be a whole number between 1 and 5, got ${JSON.stringify(value)}.`);
    }
    return Math.round(n);
}

function asWebhookUrl(value: unknown): string | null {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    if (!raw) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`\`webhookUrl\` is not a valid URL: ${raw}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`\`webhookUrl\` must be an http(s) URL, got ${url.protocol}`);
    }
    return url.toString();
}

export function parseInput(raw: RawInput): ParsedInput {
    const input = raw ?? {};

    const apps = asStringArray(input.apps, 'apps') ?? [...DEFAULT_APPS];
    if (apps.length > MAX_APPS) {
        throw new Error(`\`apps\` is limited to ${MAX_APPS} entries per run; got ${apps.length}.`);
    }

    const countries = (asStringArray(input.countries, 'countries') ?? [...DEFAULT_COUNTRIES]).map((c) =>
        c.toLowerCase(),
    );

    const rawMax = input.maxReviewsPerApp;
    let maxReviewsPerApp = DEFAULT_MAX_REVIEWS_PER_APP;
    if (rawMax != null && rawMax !== '') {
        const n = Number(rawMax);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error(`\`maxReviewsPerApp\` must be a positive number, got ${JSON.stringify(rawMax)}.`);
        }
        maxReviewsPerApp = Math.min(Math.floor(n), MAX_REVIEWS_LIMIT);
    }

    const minRating = asRating(input.minRating, 'minRating');
    const maxRating = asRating(input.maxRating, 'maxRating');
    if (minRating != null && maxRating != null && minRating > maxRating) {
        throw new Error(`\`minRating\` (${minRating}) cannot be greater than \`maxRating\` (${maxRating}).`);
    }

    const stateStoreName = String(input.stateStoreName ?? '').trim() || DEFAULT_STATE_STORE_NAME;

    return {
        apps,
        countries,
        maxReviewsPerApp,
        onlyNew: input.onlyNew == null ? true : Boolean(input.onlyNew),
        minRating,
        maxRating,
        webhookUrl: asWebhookUrl(input.webhookUrl),
        stateStoreName,
        resetState: Boolean(input.resetState),
    };
}
