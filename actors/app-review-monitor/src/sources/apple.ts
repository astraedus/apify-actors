/**
 * Apple App Store reviews via the public iTunes "customer reviews" RSS feed.
 *
 * Endpoint (public, no auth, no login):
 *   https://itunes.apple.com/{country}/rss/customerreviews/id={appId}/sortBy=mostRecent/page={n}/json
 *
 * Verified live on 2026-09-14 against id=284882215 (Facebook, US):
 *   - 50 entries per page, 10 pages max (`feed.link[rel=last]` points at page=10).
 *   - Every entry is a review; the app itself is NOT prepended on this feed, but
 *     some regions/feeds do prepend it, so entries without `im:rating` are dropped.
 *   - The feed exposes no developer replies, so `developerReply` is always null
 *     for App Store rows. Documented in the README.
 *
 * THE IMPORTANT FAILURE MODE (measured, same session):
 *   After roughly a dozen rapid requests Apple starts answering HTTP 200 with an
 *   empty feed envelope — no `entry` key, and every pagination href blanked —
 *   for EVERY app and country. It is indistinguishable, by itself, from "this app
 *   has no reviews". Reporting that as "no reviews" to a paying customer would be
 *   a silent lie, so it is disambiguated against a second public endpoint: the
 *   iTunes lookup API (a different service, not throttled alongside the feed)
 *   reports the app's rating count. Three distinct outcomes, three distinct
 *   messages:
 *     - lookup finds no app          -> AppleAppNotFoundError (bad id/country)
 *     - lookup says N>0 ratings but the feed is empty -> AppleFeedUnavailableError
 *     - lookup says 0 ratings        -> genuinely no reviews, an empty success
 */

import { log } from 'apify';
import { storeUrl } from '../detect.ts';
import { UnsafeUrlError, safeFetch } from '../safe-url.ts';
import type { ReviewRow } from '../types.ts';

/** Apple caps this feed at 10 pages of 50 reviews. */
export const APPLE_MAX_PAGES = 10;
export const APPLE_PAGE_SIZE = 50;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 2_000;

/**
 * Extra attempts when page 1 comes back VALID BUT EMPTY for an app that
 * demonstrably has ratings. Deliberately small and short: the default run has to
 * finish inside Apify's 5-minute automated-test window even when Apple is down
 * for every app in the list.
 */
const EMPTY_FEED_RETRIES = 2;
const EMPTY_FEED_RETRY_DELAY_MS = 1_500;
const USER_AGENT = 'apify-app-review-monitor/1.0 (+https://apify.com/astraedus/app-review-monitor)';

/** The app id does not exist in that storefront — the user's input is wrong. */
export class AppleAppNotFoundError extends Error {
    constructor(appId: string, country: string) {
        super(
            `No app with ID ${appId} exists in the "${country}" App Store. ` +
                'Check the numeric ID and the country code (an app can be missing from one storefront).',
        );
        this.name = 'AppleAppNotFoundError';
    }
}

/** The app has reviews, but Apple will not serve them right now — our problem, not the user's. */
export class AppleFeedUnavailableError extends Error {
    constructor(appId: string, country: string, ratingCount: number) {
        super(
            `Apple's public review feed returned no data for app ${appId} in "${country}", ` +
                `but the App Store reports ${ratingCount.toLocaleString('en-US')} ratings for it. ` +
                'The feed is rate-limiting or temporarily unavailable; the app itself is fine. Retry later.',
        );
        this.name = 'AppleFeedUnavailableError';
    }
}

/** Every scalar in this feed is wrapped as `{ label: string }`. */
interface Labelled {
    label?: unknown;
}

interface AppleEntry {
    author?: { name?: Labelled; uri?: Labelled };
    updated?: Labelled;
    'im:rating'?: Labelled;
    'im:version'?: Labelled;
    id?: Labelled;
    title?: Labelled;
    content?: Labelled;
}

interface AppleFeed {
    feed?: {
        /** Absent when there are no reviews, past the last page, or while throttled. */
        entry?: AppleEntry | AppleEntry[];
    };
}

/** What the iTunes lookup API tells us about an app. */
export interface AppleAppMeta {
    exists: boolean;
    name: string | null;
    /** Total ratings in this storefront; 0 when the app has never been rated. */
    ratingCount: number;
}

function label(node: Labelled | undefined): string | null {
    const value = node?.label;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function toIso(raw: string | null): string | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function appleFeedUrl(appId: string, country: string, page: number): string {
    return (
        `https://itunes.apple.com/${encodeURIComponent(country)}/rss/customerreviews/` +
        `id=${encodeURIComponent(appId)}/sortBy=mostRecent/page=${page}/json`
    );
}

/**
 * Parse one RSS page into normalised rows.
 *
 * Defensive against the shapes Apple's XML-to-JSON bridge produces: a missing
 * `entry` key (no reviews / past the end / throttled) and a bare object instead
 * of a one-element array (single review).
 */
export function parseAppleRssPage(
    payload: unknown,
    context: { appId: string; appName: string | null; country: string },
): ReviewRow[] {
    const feed = (payload as AppleFeed | null)?.feed;
    const raw = feed?.entry;
    if (!raw) return [];

    const entries = Array.isArray(raw) ? raw : [raw];
    const rows: ReviewRow[] = [];

    for (const entry of entries) {
        const reviewId = label(entry?.id);
        const ratingText = label(entry?.['im:rating']);
        // Entries without a rating are not reviews (some feeds prepend the app itself).
        if (!reviewId || ratingText === null) continue;

        const rating = Number.parseInt(ratingText, 10);

        rows.push({
            store: 'app-store',
            appId: context.appId,
            appName: context.appName,
            country: context.country,
            reviewId,
            rating: Number.isFinite(rating) ? rating : null,
            title: label(entry.title),
            text: label(entry.content) ?? '',
            author: label(entry.author?.name),
            date: toIso(label(entry.updated)),
            appVersion: label(entry['im:version']),
            // The RSS feed carries no developer responses.
            developerReply: null,
            url: storeUrl('app-store', context.appId, context.country),
            isNew: true,
        });
    }

    return rows;
}

/** Parse an iTunes lookup response. Exported for unit testing. */
export function parseAppleLookup(payload: unknown): AppleAppMeta {
    const result = (payload as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
    if (!result) return { exists: false, name: null, ratingCount: 0 };

    const name = typeof result['trackName'] === 'string' ? result['trackName'] : null;
    // `userRatingCount` is simply absent (not 0) for an app nobody has rated.
    const raw = result['userRatingCount'];
    const ratingCount = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return { exists: true, name, ratingCount };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            // safeFetch, not fetch: Apple's own hosts are fixed and trusted, but
            // `redirect: 'follow'` would let a hijacked/compromised 3xx walk this
            // request onto a private address. Redirects are followed by hand and
            // re-validated per hop instead.
            const response = await safeFetch(url, {
                headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, { label: 'App Store feed URL' });
            // 4xx other than 429 will not fix itself; fail immediately.
            if (!response.ok && response.status !== 429 && response.status < 500) {
                throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
            }
            if (response.ok) return await response.json();
            lastError = new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
        } catch (error) {
            // A refused redirect is not a transport hiccup: retrying it four
            // times with backoff only wastes the run's clock.
            if (error instanceof UnsafeUrlError) throw error;
            if ((error as Error).message.startsWith('HTTP 4')) throw error;
            lastError = error as Error;
        }

        if (attempt < MAX_ATTEMPTS) {
            const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1);
            log.debug(`Retrying ${url} in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError?.message}`);
            await sleep(delay);
        }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
}

/**
 * Ask the iTunes lookup API what it knows about an app. This is a different
 * service from the review feed and stays available when the feed throttles,
 * which is what makes the three-way disambiguation above possible.
 */
export async function fetchAppleAppMeta(appId: string, country: string): Promise<AppleAppMeta | null> {
    try {
        const payload = await fetchJson(
            `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`,
        );
        return parseAppleLookup(payload);
    } catch (error) {
        log.debug(`iTunes lookup failed for ${appId}/${country}: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Page through the RSS feed newest-first until `limit` rows are collected, the
 * feed runs out of entries, or Apple's 10-page ceiling is reached.
 *
 * Throws `AppleAppNotFoundError` for a bad id/country and
 * `AppleFeedUnavailableError` when the app demonstrably has reviews that Apple
 * declined to serve. An app that genuinely has no reviews returns an empty list.
 */
export async function fetchAppleReviews(
    appId: string,
    country: string,
    limit: number,
): Promise<{ reviews: ReviewRow[]; appName: string | null }> {
    const meta = await fetchAppleAppMeta(appId, country);
    if (meta && !meta.exists) {
        throw new AppleAppNotFoundError(appId, country);
    }
    const appName = meta?.name ?? null;
    const ratingCount = meta?.ratingCount ?? 0;
    /** The app is known to have reviews, so an empty page 1 is a fault worth retrying. */
    const expectsReviews = ratingCount > 0 || meta === null;
    const reviews: ReviewRow[] = [];

    for (let page = 1; page <= APPLE_MAX_PAGES && reviews.length < limit; page += 1) {
        let rows = parseAppleRssPage(await fetchJson(appleFeedUrl(appId, country, page)), {
            appId,
            appName,
            country,
        });

        // Apple intermittently answers 200 with a valid but empty feed. On page 1
        // of an app we know has reviews, give it a couple of short retries before
        // concluding the feed is unavailable.
        for (let retry = 1; rows.length === 0 && page === 1 && expectsReviews && retry <= EMPTY_FEED_RETRIES; retry += 1) {
            log.debug(`Empty App Store feed for ${appId}/${country}; retry ${retry}/${EMPTY_FEED_RETRIES}.`);
            await sleep(EMPTY_FEED_RETRY_DELAY_MS);
            rows = parseAppleRssPage(await fetchJson(appleFeedUrl(appId, country, page)), {
                appId,
                appName,
                country,
            });
        }

        if (rows.length === 0) break;
        reviews.push(...rows);
        // A short page means the feed is exhausted; stop rather than burn a request.
        if (rows.length < APPLE_PAGE_SIZE) break;
    }

    if (reviews.length === 0) {
        // An empty feed means one of two very different things. Say which.
        if (expectsReviews) {
            throw new AppleFeedUnavailableError(appId, country, ratingCount);
        }
        log.info(`App ${appId} has no ratings in the "${country}" App Store yet — nothing to monitor.`);
    }

    return { reviews: reviews.slice(0, limit), appName };
}
