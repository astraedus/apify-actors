/**
 * Google Play reviews via the `google-play-scraper` package (v10, ESM-only),
 * which talks to the same public `batchexecute` endpoint the store's own web
 * client uses. No login, no cookies, public data only.
 *
 * Verified live on 2026-09-14 (v10.1.3, `dev.astraedus.nudge` and `com.whatsapp`):
 *   - `import gplay from 'google-play-scraper'` — default export object.
 *   - `gplay.reviews({...})` resolves to `{ data: Review[], nextPaginationToken }`
 *     and internally pages until `num` is satisfied (num=200 returned 200 rows).
 *   - `date` already arrives as an ISO-8601 string.
 *   - `title` is always null — Google Play removed review titles years ago.
 *   - `replyText` / `replyDate` carry the developer's public response.
 */

import { log } from 'apify';
import gplay from 'google-play-scraper';
import { storeUrl } from '../detect.ts';
import type { ReviewRow } from '../types.ts';

/** Play's own web client will not hand out more than this in one sitting. */
export const GOOGLE_PLAY_MAX_REVIEWS = 1000;

/**
 * `sort.NEWEST` as of google-play-scraper 10.1.3. The package's own typings
 * declare `sort: sort` (the enum TYPE) instead of `typeof sort`, so
 * `gplay.sort.NEWEST` does not type-check even though it exists at runtime.
 * `newestSortValue()` prefers the package's value and falls back to this
 * literal; test/google-play.test.ts asserts the two still agree, so a package
 * update that renumbered the enum fails the suite instead of silently
 * re-sorting every customer's feed by relevance.
 */
export const SORT_NEWEST_FALLBACK = 2;

export function newestSortValue(): number {
    const table = (gplay as unknown as { sort?: Record<string, unknown> }).sort;
    const value = table?.['NEWEST'];
    return typeof value === 'number' ? value : SORT_NEWEST_FALLBACK;
}

interface GplayReview {
    id?: unknown;
    userName?: unknown;
    date?: unknown;
    score?: unknown;
    title?: unknown;
    text?: unknown;
    replyDate?: unknown;
    replyText?: unknown;
    version?: unknown;
    url?: unknown;
}

function str(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function toIso(value: unknown): string | null {
    if (typeof value !== 'string' && !(value instanceof Date)) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Normalise one raw package review. Exported so it can be unit-tested. */
export function normaliseGooglePlayReview(
    raw: GplayReview,
    context: { appId: string; appName: string | null; country: string },
): ReviewRow | null {
    const reviewId = str(raw.id);
    if (!reviewId) return null;

    const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null;
    const replyText = str(raw.replyText);

    return {
        store: 'google-play',
        appId: context.appId,
        appName: context.appName,
        country: context.country,
        reviewId,
        rating: score,
        title: str(raw.title),
        text: str(raw.text) ?? '',
        author: str(raw.userName),
        date: toIso(raw.date),
        appVersion: str(raw.version),
        developerReply: replyText ? { text: replyText, date: toIso(raw.replyDate) } : null,
        url: str(raw.url) ?? storeUrl('google-play', context.appId, context.country),
        isNew: true,
    };
}

/**
 * The app exists and Play publishes a review count for it, but the review
 * endpoint returned nothing — a transport fault, not an app without reviews.
 */
export class GooglePlayFeedUnavailableError extends Error {
    constructor(appId: string, country: string, reviewCount: number) {
        super(
            `Google Play returned no reviews for "${appId}" in "${country}", but the store page ` +
                `reports ${reviewCount.toLocaleString('en-US')} reviews for it. ` +
                'The review endpoint is rate-limiting or temporarily unavailable; the app itself is fine. Retry later.',
        );
        this.name = 'GooglePlayFeedUnavailableError';
    }
}

export interface GooglePlayAppMeta {
    name: string | null;
    /**
     * Reviews Play publicly reports, or null when it publishes no count — which
     * it does for low-volume apps, so null means "unknown", NOT "zero".
     */
    reviewCount: number | null;
}

/** Parse a google-play-scraper app() result. Exported for unit testing. */
export function parseGooglePlayAppMeta(app: unknown): GooglePlayAppMeta {
    const record = (app ?? {}) as Record<string, unknown>;
    const reviews = record['reviews'];
    return {
        name: str(record['title']),
        reviewCount: typeof reviews === 'number' && Number.isFinite(reviews) ? reviews : null,
    };
}

/**
 * Resolve the app's display title and public review count.
 * A missing package throws (google-play-scraper raises "App not found (404)"),
 * which is the right outcome: the user's input is wrong and should say so.
 */
export async function fetchGooglePlayAppMeta(appId: string, country: string): Promise<GooglePlayAppMeta> {
    return parseGooglePlayAppMeta(await gplay.app({ appId, country, lang: 'en' }));
}

export async function fetchGooglePlayReviews(
    appId: string,
    country: string,
    limit: number,
): Promise<{ reviews: ReviewRow[]; appName: string | null }> {
    const meta = await fetchGooglePlayAppMeta(appId, country);
    const appName = meta.name;
    const num = Math.min(Math.max(1, Math.floor(limit)), GOOGLE_PLAY_MAX_REVIEWS);

    const result = (await gplay.reviews({
        appId,
        country,
        lang: 'en',
        sort: newestSortValue(),
        num,
    })) as { data?: GplayReview[] };

    const raw = Array.isArray(result?.data) ? result.data : [];
    const reviews = raw
        .map((review) => normaliseGooglePlayReview(review, { appId, appName, country }))
        .filter((row): row is ReviewRow => row !== null);

    if (reviews.length === 0) {
        // "No reviews" and "Play would not serve them" need different answers:
        // the first is a fact about the app, the second is a fault worth retrying.
        if (meta.reviewCount !== null && meta.reviewCount > 0) {
            throw new GooglePlayFeedUnavailableError(appId, country, meta.reviewCount);
        }
        log.info(`"${appName ?? appId}" has no reviews in the "${country}" Play store yet — nothing to monitor.`);
    }

    return { reviews: reviews.slice(0, limit), appName };
}
