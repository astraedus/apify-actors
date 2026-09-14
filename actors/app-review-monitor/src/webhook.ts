/**
 * Optional outbound webhook: one POST per run carrying a compact summary.
 *
 * Failure is never fatal — a user's Slack/Zapier endpoint being down must not
 * fail a scrape that already succeeded and already charged the customer.
 */

import { log } from 'apify';
import type { AppCheckResult, ReviewRow } from './types.ts';

const WEBHOOK_TIMEOUT_MS = 15_000;
/** Keep the payload small enough for Slack/Zapier/Make to accept comfortably. */
const MAX_LOWEST_REVIEWS = 5;
const MAX_TEXT_CHARS = 500;

export interface WebhookPayload {
    actor: 'app-review-monitor';
    runAt: string;
    totals: { appsChecked: number; newReviews: number; errors: number };
    apps: Array<{
        store: string;
        appId: string;
        appName: string | null;
        country: string;
        newCount: number;
        avgRating: number | null;
        firstRun: boolean;
        error?: string;
        lowestReviews: Array<{
            reviewId: string;
            rating: number | null;
            title: string | null;
            text: string;
            author: string | null;
            date: string | null;
            url: string;
        }>;
    }>;
}

function trimReview(r: ReviewRow) {
    return {
        reviewId: r.reviewId,
        rating: r.rating,
        title: r.title,
        text: r.text.length > MAX_TEXT_CHARS ? `${r.text.slice(0, MAX_TEXT_CHARS)}…` : r.text,
        author: r.author,
        date: r.date,
        url: r.url,
    };
}

export function buildWebhookPayload(results: readonly AppCheckResult[]): WebhookPayload {
    return {
        actor: 'app-review-monitor',
        runAt: new Date().toISOString(),
        totals: {
            appsChecked: results.length,
            newReviews: results.reduce((sum, r) => sum + r.newCount, 0),
            errors: results.filter((r) => r.error).length,
        },
        apps: results.map((r) => ({
            store: r.store,
            appId: r.appId,
            appName: r.appName,
            country: r.country,
            newCount: r.newCount,
            avgRating: r.avgRating,
            firstRun: r.firstRun,
            ...(r.error ? { error: r.error } : {}),
            lowestReviews: r.lowestReviews.slice(0, MAX_LOWEST_REVIEWS).map(trimReview),
        })),
    };
}

export async function postWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': 'apify-app-review-monitor/1.0',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (!response.ok) {
            log.warning(`Webhook POST returned HTTP ${response.status} ${response.statusText}.`);
            return false;
        }
        log.info(`Webhook delivered to ${new URL(url).host} (HTTP ${response.status}).`);
        return true;
    } catch (error) {
        log.warning(`Webhook POST failed: ${(error as Error).message}. The run itself is unaffected.`);
        return false;
    }
}
