/**
 * Build-time smoke check, run by the Dockerfile.
 *
 * Imports every runtime module so that a broken import, a missing dependency,
 * or a TypeScript construct that Node's native type stripping cannot erase
 * fails the BUILD instead of the first paying customer's run.
 * `main.ts` is deliberately excluded — importing it would start an Actor run.
 */

import { buildCheckList, detectAppTarget } from './detect.ts';
import { CHARGEABLE_EVENTS } from './charging.ts';
import { selectNewReviews } from './incremental.ts';
import { parseInput } from './input.ts';
import { buildRunNote, isTransientSourceFailure } from './outcome.ts';
import { UnsafeUrlError, assertSafeOutboundUrl } from './safe-url.ts';
import { AppleFeedUnavailableError, parseAppleRssPage } from './sources/apple.ts';
import { normaliseGooglePlayReview } from './sources/google-play.ts';
import { buildWebhookPayload } from './webhook.ts';
import { DEFAULT_STATE_STORE_NAME } from './state.ts';

const checks = buildCheckList(parseInput(null).apps, parseInput(null).countries);
const stores = new Set(checks.map((c) => c.store));

if (!stores.has('google-play') || !stores.has('app-store')) {
    throw new Error('Default input must exercise both stores.');
}
if (detectAppTarget('284882215').store !== 'app-store') throw new Error('Apple detection broken.');
if (selectNewReviews([{ reviewId: 'a' }], [], { onlyNew: true, maxReviews: 1 }).emitted.length !== 1) {
    throw new Error('Incremental selection broken.');
}
if (parseAppleRssPage({ feed: {} }, { appId: '1', appName: null, country: 'us' }).length !== 0) {
    throw new Error('Apple parser should treat a feed with no entries as empty.');
}
if (normaliseGooglePlayReview({}, { appId: '1', appName: null, country: 'us' }) !== null) {
    throw new Error('Google Play normaliser should reject a review with no id.');
}
if (buildWebhookPayload([]).totals.appsChecked !== 0) throw new Error('Webhook payload broken.');
if (!isTransientSourceFailure(new AppleFeedUnavailableError('1', 'us', 5))) {
    throw new Error('An unavailable store feed must classify as transient, or a store outage fails customer runs.');
}
if (!buildRunNote(1, 0, [], []).includes('every app was reached')) throw new Error('Run note broken.');

// The SSRF guard is a build-time gate, not just a unit test: an image that
// would happily POST a run summary to the cloud metadata endpoint must never
// be produced, whatever happened to the tests.
for (const hostile of ['http://0xa9.0xfe.0xa9.0xfe/', 'http://127.1/hook', 'http://[::1]/hook', 'http://localhost/hook']) {
    let refused = false;
    try {
        assertSafeOutboundUrl(hostile, { label: 'webhookUrl' });
    } catch (error) {
        refused = error instanceof UnsafeUrlError;
    }
    if (!refused) throw new Error(`SSRF guard let ${hostile} through.`);
}
if (assertSafeOutboundUrl('https://hooks.example.com/x').hostname !== 'hooks.example.com') {
    throw new Error('SSRF guard rejects a legitimate public webhook.');
}

console.log(
    `Self-test OK — ${checks.length} default checks, events: ${CHARGEABLE_EVENTS.join(', ')}, state store: ${DEFAULT_STATE_STORE_NAME}`,
);
