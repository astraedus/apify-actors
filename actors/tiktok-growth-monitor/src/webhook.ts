/**
 * The optional outbound webhook: one POST per run carrying the run summary.
 *
 * `webhookUrl` is the one input that makes this Actor open a connection to a
 * host of the user's choosing, from inside Apify's network — an SSRF sink. It is
 * therefore validated twice against the same guard: once at input time (so a
 * bad URL fails before any work is paid for) and once immediately before the
 * POST, which is the call that actually opens the socket.
 */

import { log } from 'apify';

import { assertSafeOutboundUrl, nonStandardPortAllowed, safeFetch } from './safe-url.ts';

const WEBHOOK_TIMEOUT_MS = 15_000;

/** The guard options every outbound webhook call shares. */
function guardOptions(): { label: string; allowNonStandardPort: boolean } {
    return { label: 'webhookUrl', allowNonStandardPort: nonStandardPortAllowed() };
}

/**
 * Validate a user-supplied webhook URL, returning its canonical form.
 * Throws `UnsafeUrlError` with a message the user can act on.
 */
export function validateWebhookUrl(raw: string): string {
    return assertSafeOutboundUrl(raw, guardOptions()).toString();
}

/**
 * Deliver the summary. Never throws: a customer's Slack/Make endpoint being
 * down must not fail a run whose data is already in the dataset and already
 * charged.
 */
export async function postWebhook(url: string, body: unknown): Promise<boolean> {
    const guard = guardOptions();
    try {
        const target = assertSafeOutboundUrl(url, guard);
        const response = await safeFetch(
            target,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            },
            guard,
        );

        if (!response.ok) {
            log.warning(`Webhook returned HTTP ${response.status}; the run itself succeeded.`);
            return false;
        }

        log.info(`Run summary POSTed to the webhook at ${target.host}.`);
        return true;
    } catch (error) {
        log.warning('Webhook POST failed; the run itself succeeded and the data is in the dataset.', {
            error: (error as Error).message,
        });
        return false;
    }
}
