/**
 * Incremental de-duplication and rating filters.
 *
 * Pure module: every function here is a total function of its arguments with no
 * I/O, so the incremental contract can be unit-tested exhaustively without
 * touching the network or the Apify platform. `state.ts` owns the persistence.
 */

import type { ReviewRow } from './types.ts';

/**
 * How many review ids we remember per app+country. Play and the iTunes RSS both
 * expose at most a few hundred recent reviews, so a few thousand ids is many
 * runs of headroom while keeping the key-value record small (~50 KB).
 */
export const MAX_SEEN_IDS = 5000;

export interface RatingFilter {
    minRating?: number | null;
    maxRating?: number | null;
}

/** True when the review's rating falls inside the (inclusive) filter window. */
export function passesRatingFilter(review: Pick<ReviewRow, 'rating'>, filter: RatingFilter): boolean {
    const { minRating, maxRating } = filter;
    if (minRating == null && maxRating == null) return true;
    // A review with no rating cannot satisfy a rating window; drop it rather
    // than silently treating "unknown" as "matches".
    if (review.rating == null) return false;
    if (minRating != null && review.rating < minRating) return false;
    if (maxRating != null && review.rating > maxRating) return false;
    return true;
}

export function applyRatingFilter<T extends Pick<ReviewRow, 'rating'>>(
    reviews: readonly T[],
    filter: RatingFilter,
): T[] {
    return reviews.filter((r) => passesRatingFilter(r, filter));
}

export interface SelectOptions {
    /** When false, every fetched review is emitted and state is still advanced. */
    onlyNew: boolean;
    /** Hard cap on rows emitted for this app+country. */
    maxReviews: number;
}

export interface SelectResult<T> {
    /** Rows to push to the dataset, newest-first order preserved from the input. */
    emitted: T[];
    /** The seen-id list to persist, most-recent-first and capped at MAX_SEEN_IDS. */
    nextSeen: string[];
    /** True when `seen` was empty, i.e. nothing was ever stored for this app+country. */
    firstRun: boolean;
    /** Rows dropped because a previous run already emitted them. */
    skippedAsSeen: number;
}

/**
 * Decide which of the freshly fetched reviews are new, and what to persist.
 *
 * Contract:
 *  - First run (no stored ids) emits up to `maxReviews` so a brand-new schedule
 *    has a baseline instead of an empty dataset.
 *  - Later runs emit only ids absent from `seen`, again capped at `maxReviews`.
 *  - `onlyNew: false` emits everything (capped) but STILL advances state, so a
 *    user can flip the flag back on without re-emitting the same backlog.
 *  - Reviews fetched in this run are always recorded as seen even when the
 *    `maxReviews` cap truncated the emission — otherwise a cap smaller than the
 *    daily review volume would replay the same overflow forever.
 *  - Duplicate ids inside one fetch are collapsed (Play occasionally repeats a
 *    review across pagination pages).
 */
export function selectNewReviews<T extends { reviewId: string }>(
    fetched: readonly T[],
    seen: readonly string[],
    options: SelectOptions,
): SelectResult<T> {
    const seenSet = new Set(seen);
    const firstRun = seenSet.size === 0;
    const maxReviews = Math.max(0, Math.floor(options.maxReviews));

    const deduped: T[] = [];
    const withinRun = new Set<string>();
    for (const review of fetched) {
        if (!review.reviewId || withinRun.has(review.reviewId)) continue;
        withinRun.add(review.reviewId);
        deduped.push(review);
    }

    const emitAll = !options.onlyNew || firstRun;
    const candidates = emitAll ? deduped : deduped.filter((r) => !seenSet.has(r.reviewId));
    const skippedAsSeen = emitAll ? 0 : deduped.length - candidates.length;
    const emitted = candidates.slice(0, maxReviews);

    // Newest ids first: everything from this fetch, then the previous tail.
    const nextSeen: string[] = [];
    const nextSet = new Set<string>();
    for (const id of [...withinRun, ...seen]) {
        if (nextSet.has(id)) continue;
        nextSet.add(id);
        nextSeen.push(id);
        if (nextSeen.length >= MAX_SEEN_IDS) break;
    }

    return { emitted, nextSeen, firstRun, skippedAsSeen };
}

/** Mean of the rows' ratings, rounded to 2dp; null when no row carried a rating. */
export function averageRating(rows: readonly Pick<ReviewRow, 'rating'>[]): number | null {
    const ratings = rows.map((r) => r.rating).filter((r): r is number => typeof r === 'number');
    if (ratings.length === 0) return null;
    const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    return Math.round(mean * 100) / 100;
}

/** The `limit` worst-rated rows, lowest first; unrated rows are excluded. */
export function lowestRated<T extends Pick<ReviewRow, 'rating'>>(rows: readonly T[], limit: number): T[] {
    return rows
        .filter((r) => typeof r.rating === 'number')
        .slice()
        .sort((a, b) => (a.rating as number) - (b.rating as number))
        .slice(0, limit);
}
