/**
 * Input parsing and validation.
 *
 * Kept pure (no SDK calls) so the whole contract — including every default —
 * is unit-testable, and so a bad input fails with one clear message before a
 * single network request or charge happens.
 */

import { assertSafeOutboundUrl, nonStandardPortAllowed } from './safe-url.ts';
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

/**
 * Reviews per app in a demo run. A demo re-emits its baseline every time, so it
 * is deliberately small: enough to show what the output looks like, cheap enough
 * to run every day forever.
 */
export const DEMO_MAX_REVIEWS_PER_APP = 10;

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
    /**
     * True when the caller configured nothing at all, so this run is the
     * zero-config demo: Apify's daily reliability test, or somebody pressing
     * Start to see what the Actor does. See `isZeroConfigRun`.
     */
    isDemoRun: boolean;
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

/**
 * Validate the webhook URL before the run does any work.
 *
 * This is an SSRF sink: whatever goes in here is a host this Actor connects to
 * from inside Apify's network, so it is checked against the same guard that
 * runs again immediately before the POST (and on every redirect hop). Failing
 * here rather than at delivery time means a bad URL costs the user nothing.
 */
function asWebhookUrl(value: unknown): string | null {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    if (!raw) return null;
    return assertSafeOutboundUrl(raw, {
        label: 'webhookUrl',
        allowNonStandardPort: nonStandardPortAllowed(),
    }).toString();
}

/** Set equality, so the order the apps were listed in does not matter. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const left = new Set(a);
    if (left.size !== new Set(b).size) return false;
    return b.every((value) => left.has(value));
}

/**
 * True when NOTHING that shapes the output was configured.
 *
 * This cannot be answered by asking whether `apps` was supplied: Apify
 * materialises the input schema's `default` values into the stored INPUT, so an
 * empty `{}` POST reaches the Actor with `apps`, `countries`, `maxReviewsPerApp`
 * and `stateStoreName` already filled in. An absent field is therefore
 * indistinguishable from a defaulted one, and any check for "no apps given"
 * would be dead code on the platform.
 *
 * So the question is asked the other way round: is every output-shaping field
 * still exactly the built-in default? Changing any one of them — your own apps,
 * another country, a rating filter, your own state store — opts into the real
 * product with its persistent cross-run state. That keeps the rule honest in
 * both directions: Apify's daily test and a first-time Start always get data,
 * and a caller who configured something always gets true incremental behaviour.
 */
export function isZeroConfigRun(input: Omit<ParsedInput, 'isDemoRun'>): boolean {
    return (
        sameSet(input.apps, DEFAULT_APPS)
        && sameSet(input.countries, DEFAULT_COUNTRIES)
        && input.maxReviewsPerApp === DEFAULT_MAX_REVIEWS_PER_APP
        && input.onlyNew
        && input.minRating == null
        && input.maxRating == null
        && input.stateStoreName === DEFAULT_STATE_STORE_NAME
    );
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

    const parsed: Omit<ParsedInput, 'isDemoRun'> = {
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

    const isDemoRun = isZeroConfigRun(parsed);

    return {
        ...parsed,
        // A demo re-emits its baseline on every run, so it is capped low: the
        // point is to show the shape of the output, not to ship a backlog.
        maxReviewsPerApp: isDemoRun ? DEMO_MAX_REVIEWS_PER_APP : parsed.maxReviewsPerApp,
        isDemoRun,
    };
}
