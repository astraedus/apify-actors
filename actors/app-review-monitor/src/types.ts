import type { Store } from './detect.ts';

/** A developer's public reply to a review. */
export interface DeveloperReply {
    text: string;
    /** ISO-8601, or null when the store did not expose a reply date. */
    date: string | null;
}

/**
 * One normalised review row. This is the dataset schema — the shape is part of
 * the actor's public contract, so fields are never removed, only added.
 */
export interface ReviewRow {
    store: Store;
    appId: string;
    appName: string | null;
    country: string;
    reviewId: string;
    rating: number | null;
    title: string | null;
    text: string;
    author: string | null;
    /** ISO-8601 timestamp of the review, or null when the store omitted it. */
    date: string | null;
    appVersion: string | null;
    developerReply: DeveloperReply | null;
    /** Canonical public URL of the review, falling back to the app's store page. */
    url: string;
    /**
     * True when this row had not been seen by a previous run of this actor
     * (always true while `onlyNew` is enabled, since old rows are dropped).
     */
    isNew: boolean;
}

/** Per app+country outcome, used for the webhook summary and the run log. */
export interface AppCheckResult {
    store: Store;
    appId: string;
    appName: string | null;
    country: string;
    /** Reviews fetched from the store before filtering. */
    fetchedCount: number;
    /** Rows actually pushed to the dataset. */
    newCount: number;
    /** Mean rating of the pushed rows, rounded to 2dp; null when nothing was pushed. */
    avgRating: number | null;
    /** Up to 5 worst-rated pushed rows, for alerting. */
    lowestReviews: ReviewRow[];
    /** True the first time this app+country is seen (no stored state). */
    firstRun: boolean;
    /** Populated when the store could not be reached; the run continues. */
    error?: string;
    /**
     * True when the failure was the store declining to serve data (rate limiting,
     * an empty-but-valid feed, a 5xx) rather than anything the user can fix.
     * Transient failures never fail the run and are re-fetched from scratch next
     * time, because no state was advanced for them.
     */
    transient?: boolean;
}
