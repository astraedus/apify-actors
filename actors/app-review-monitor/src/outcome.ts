/**
 * Classifying how a run went, and saying so in one plain-English line.
 *
 * Kept separate from main.ts and free of I/O so the classification — which
 * decides whether a customer's scheduled run is marked FAILED — is unit-tested
 * rather than trusted.
 */

import { AppleFeedUnavailableError } from './sources/apple.ts';
import { GooglePlayFeedUnavailableError } from './sources/google-play.ts';
import type { AppCheckResult } from './types.ts';

/**
 * True when the store declined to serve data rather than the user asking for
 * something impossible. Transient failures are self-healing: no state is
 * advanced for them, so the next run re-fetches from scratch.
 */
export function isTransientSourceFailure(error: unknown): boolean {
    if (error instanceof AppleFeedUnavailableError || error instanceof GooglePlayFeedUnavailableError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Network-level faults and server-side errors; a 4xx other than 429 is the
    // user's problem (wrong id, wrong country) and is deliberately excluded.
    return /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timed out|The operation was aborted/i.test(
        message,
    );
}

export interface RunNoteOptions {
    /**
     * True when this was the zero-config demo run, which keeps no state between
     * runs. Saying so matters: without it, a reader comparing two demo runs
     * would reasonably conclude the de-duplication is broken.
     */
    demoRun?: boolean;
}

/** One line a human can read without opening the log. */
export function buildRunNote(
    checkCount: number,
    newReviews: number,
    transientFailures: readonly AppCheckResult[],
    realFailures: readonly AppCheckResult[],
    options: RunNoteOptions = {},
): string {
    const parts = [`Checked ${checkCount} app/country pair(s); emitted ${newReviews} new review(s).`];

    if (options.demoRun) {
        parts.push(
            'This was a zero-configuration demo run over the example apps, so it used per-run state that is '
                + 'discarded when the run ends: every app counted as new and a small baseline was emitted. '
                + 'Set `apps` to your own apps for real monitoring, where seen reviews are remembered between '
                + 'runs and each run returns only what you have not received before.',
        );
    }

    if (transientFailures.length > 0) {
        parts.push(
            `${transientFailures.length} app(s) were skipped because the store returned no data ` +
                '(rate limiting or a temporary outage). Nothing was marked as seen for them and nothing was ' +
                'charged, so the next run re-fetches them in full.',
        );
    }
    if (realFailures.length > 0) {
        parts.push(
            `${realFailures.length} app(s) failed for a reason worth checking: ` +
                `${realFailures.map((r) => `${r.appId} (${r.country}) — ${r.error}`).join('; ')}`,
        );
    }
    if (transientFailures.length === 0 && realFailures.length === 0 && newReviews === 0) {
        parts.push('No new reviews since the last run — every app was reached successfully.');
    }

    return parts.join(' ');
}
