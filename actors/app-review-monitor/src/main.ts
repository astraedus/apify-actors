/**
 * App Store Review Monitor — Apify Actor entry point.
 *
 * Checks a list of Google Play and Apple App Store apps for reviews that no
 * previous run has seen, pushes them to the dataset, and optionally POSTs a
 * summary to a webhook. Built to be scheduled: the interesting output is the
 * delta, not the backlog.
 */

import { Actor, log } from 'apify';

import { buildCheckList, storeUrl } from './detect.ts';
import { CHARGEABLE_EVENTS, EVENT_APP_CHECKED, EVENT_REVIEW_EMITTED, chargeSafely, remainingReviewBudget } from './charging.ts';
import { applyRatingFilter, averageRating, lowestRated, selectNewReviews } from './incremental.ts';
import { parseInput } from './input.ts';
import { SeenStore } from './state.ts';
import { fetchAppleReviews } from './sources/apple.ts';
import { fetchGooglePlayReviews } from './sources/google-play.ts';
import type { AppCheckResult, ReviewRow } from './types.ts';
import { buildWebhookPayload, postWebhook } from './webhook.ts';

/** Worst reviews carried in the webhook payload per app. */
const LOWEST_REVIEWS_IN_SUMMARY = 5;

await Actor.init();

try {
    const input = parseInput(await Actor.getInput<Record<string, unknown>>());
    const checks = buildCheckList(input.apps, input.countries);

    log.info(
        `Checking ${checks.length} app/country pair(s) — ${input.apps.length} app(s) x ${input.countries.length} country/countries. ` +
            `onlyNew=${input.onlyNew}, maxReviewsPerApp=${input.maxReviewsPerApp}.`,
    );

    const seenStore = await SeenStore.open(input.stateStoreName);
    const results: AppCheckResult[] = [];
    let totalPushed = 0;

    for (const check of checks) {
        const { store, appId, country } = check;
        const label = `${store}:${appId}:${country}`;

        if (input.resetState) {
            await seenStore.reset(store, appId, country);
        }

        let fetched: ReviewRow[] = [];
        let appName: string | null = null;
        try {
            const result =
                store === 'google-play'
                    ? await fetchGooglePlayReviews(appId, country, input.maxReviewsPerApp)
                    : await fetchAppleReviews(appId, country, input.maxReviewsPerApp);
            fetched = result.reviews;
            appName = result.appName;
            // Charged only once the store actually answered. A check that failed
            // because the store rate-limited us is our cost, never the user's.
            await chargeSafely(EVENT_APP_CHECKED);
        } catch (error) {
            const message = (error as Error).message;
            log.exception(error as Error, `Failed to check ${label}; continuing with the remaining apps.`);
            results.push({
                store,
                appId,
                appName: null,
                country,
                fetchedCount: 0,
                newCount: 0,
                avgRating: null,
                lowestReviews: [],
                firstRun: false,
                error: message,
            });
            continue;
        }

        const filtered = applyRatingFilter(fetched, {
            minRating: input.minRating,
            maxRating: input.maxRating,
        });

        const seen = await seenStore.get(store, appId, country);
        // Respect the user's own spend cap: never push rows we cannot charge for.
        const budget = await remainingReviewBudget();
        const cap = Math.min(input.maxReviewsPerApp, Math.max(0, budget - totalPushed));

        const selection = selectNewReviews(filtered, seen, {
            onlyNew: input.onlyNew,
            maxReviews: cap,
        });

        const rows = selection.emitted.map((row) => ({ ...row, isNew: true, url: row.url || storeUrl(store, appId, country) }));

        if (rows.length > 0) {
            await Actor.pushData(rows);
            await chargeSafely(EVENT_REVIEW_EMITTED, rows.length);
            totalPushed += rows.length;
        }

        // State advances even when nothing was emitted, so a rating filter or a
        // spend cap cannot make the same reviews reappear on every future run.
        await seenStore.set(store, appId, country, selection.nextSeen);

        results.push({
            store,
            appId,
            appName,
            country,
            fetchedCount: fetched.length,
            newCount: rows.length,
            avgRating: averageRating(rows),
            lowestReviews: lowestRated(rows, LOWEST_REVIEWS_IN_SUMMARY),
            firstRun: selection.firstRun,
        });

        log.info(
            `${appName ?? appId} (${store}/${country}): fetched ${fetched.length}, ` +
                `new ${rows.length}${selection.firstRun ? ' (first run — baseline)' : ''}` +
                `${selection.skippedAsSeen > 0 ? `, ${selection.skippedAsSeen} already seen` : ''}.`,
        );
    }

    if (input.webhookUrl) {
        await postWebhook(input.webhookUrl, buildWebhookPayload(results));
    }

    const failed = results.filter((r) => r.error);
    log.info(
        `Done. ${totalPushed} new review(s) across ${results.length} check(s)` +
            `${failed.length > 0 ? `, ${failed.length} check(s) failed` : ''}.`,
    );

    // Every check failing is a real failure — surface it so the run is marked
    // failed rather than silently succeeding with an empty dataset.
    if (results.length > 0 && failed.length === results.length) {
        throw new Error(
            `All ${results.length} checks failed. First error: ${failed[0]?.error ?? 'unknown'}`,
        );
    }

    await Actor.setValue('RUN_SUMMARY', {
        checkedAt: new Date().toISOString(),
        chargeableEvents: CHARGEABLE_EVENTS,
        totalNewReviews: totalPushed,
        checks: results.map(({ lowestReviews: _lowest, ...rest }) => rest),
    });
} finally {
    await Actor.exit();
}
