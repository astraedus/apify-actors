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
import { buildRunNote, isTransientSourceFailure } from './outcome.ts';
import { SeenStore, stateStoreNameFor } from './state.ts';
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

    if (input.isDemoRun) {
        log.info(
            'Zero-configuration demo run: using this run\'s own key-value store for the seen-review state, so '
                + `every app is treated as new and up to ${input.maxReviewsPerApp} review(s) each are emitted. `
                + 'Set `apps` to your own apps to switch on real incremental monitoring, where state persists '
                + `in the named store "${input.stateStoreName}" and each run returns only what it has not sent before.`,
        );
    }

    const seenStore = await SeenStore.open(stateStoreNameFor(input));
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
            const transient = isTransientSourceFailure(error);
            if (transient) {
                // An expected, self-healing condition: log it plainly, with no
                // stack trace, so a store outage does not read like a crash.
                log.warning(`${label}: ${message} Skipping this app; the next run retries it.`);
            } else {
                log.exception(error as Error, `Failed to check ${label}; continuing with the remaining apps.`);
            }
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
                transient,
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

    const failed = results.filter((r) => r.error);
    const transientFailures = failed.filter((r) => r.transient);
    const realFailures = failed.filter((r) => !r.transient);
    const runNote = buildRunNote(results.length, totalPushed, transientFailures, realFailures, {
        demoRun: input.isDemoRun,
    });

    log.info(
        `Done. ${totalPushed} new review(s) across ${results.length} check(s)` +
            `${failed.length > 0 ? `, ${failed.length} check(s) failed` : ''}.`,
    );
    if (transientFailures.length > 0) {
        log.warning(
            `${transientFailures.length} app(s) could not be checked because the store declined to serve data: ` +
                `${transientFailures.map((r) => `${r.store}:${r.appId}:${r.country}`).join(', ')}. ` +
                'Nothing was marked as seen for them, so the next run picks up everything they missed.',
        );
    }

    if (input.webhookUrl) {
        await postWebhook(input.webhookUrl, buildWebhookPayload(results, runNote));
    }

    await Actor.setValue('RUN_SUMMARY', {
        checkedAt: new Date().toISOString(),
        chargeableEvents: CHARGEABLE_EVENTS,
        totalNewReviews: totalPushed,
        runNote,
        checks: results.map(({ lowestReviews: _lowest, ...rest }) => rest),
    });

    // A store refusing to serve data is not our customer's failed run: the next
    // scheduled run recovers on its own and nothing was lost or billed. Only a
    // failure the user could act on (bad app ID, bad input) fails the run.
    if (results.length > 0 && realFailures.length === results.length) {
        throw new Error(`All ${results.length} checks failed. First error: ${realFailures[0]?.error ?? 'unknown'}`);
    }
} finally {
    await Actor.exit();
}
